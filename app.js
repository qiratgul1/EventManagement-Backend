require("dotenv").config();
const express = require("express");
const http = require("http");
const mongoose = require("mongoose");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const nodemailer = require("nodemailer");
const { Server } = require("socket.io");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
const path = require("path");
const fs = require("fs");

const User = require("./models/User");
const Expo = require("./models/Expo");
const Booth = require("./models/Booth");
const ExhibitorProfile = require("./models/ExhibitorProfile");
const Application = require("./models/Application");
const Session = require("./models/Session");
const Registration = require("./models/Registration");
const Message = require("./models/Message");
const Feedback = require("./models/Feedback");
const Notification = require("./models/Notification");

// ================= CLOUDINARY =================

cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
});

// keep file in memory (max 5MB), only images and PDFs
const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"];
        if (allowed.includes(file.mimetype)) return cb(null, true);
        cb(new Error("Only JPG, PNG, WEBP, GIF and PDF files are allowed"));
    }
});

const uploadToCloudinary = (buffer, folder) => new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
        { folder: `eventsphere/${folder}`, resource_type: "auto" },
        (error, result) => (error ? reject(error) : resolve(result))
    );
    stream.end(buffer);
});


const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: "1mb" })); // middleware used to parse JSON
app.use(cors());
app.use(helmet());                                                        // secure HTTP headers
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev")); // request logging
app.use("/api", rateLimit({ windowMs: 60 * 1000, limit: 300 }));          // general rate limit
app.use(["/login", "/register", "/forgot-password", "/reset-password"],
    rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, message: { message: "Too many attempts, please try again later" } }));


// ================= LOCAL UPLOADS (fallback when Cloudinary fails) =================

const UPLOAD_DIR = path.join(__dirname, "uploads");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// CORP header lets the frontend (another port) display these images
app.use("/uploads", express.static(UPLOAD_DIR, {
    setHeaders: (res) => res.setHeader("Cross-Origin-Resource-Policy", "cross-origin")
}));

const cloudinaryReady = () =>
    !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);

const saveLocally = (file, req) => {
    const ext = path.extname(file.originalname || "").toLowerCase().replace(/[^.a-z0-9]/g, "");
    const name = `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`;
    fs.writeFileSync(path.join(UPLOAD_DIR, name), file.buffer);
    return `${req.protocol}://${req.get("host")}/uploads/${name}`;
};


// ================= PORT ===================

const PORT = process.env.PORT || 3000;


// ================= MONGODB =================

mongoose.connect(process.env.MONGO_URL)

    .then(() => {
        console.log("MongoDB Connected Successfully!");
    })

    .catch((error) => {
        console.log("Connection Failed: ", error);
    });


// ================= SOCKET.IO (REAL-TIME) =================
// Client: io(URL, { auth: { token } })  then  socket.emit("join-expo", expoId)
// Events: booth-updated, schedule-updated, expo-updated, new-message, new-notification, analytics-update

const io = new Server(server, { cors: { origin: "*" } });

io.use(async (socket, next) => {
    try {
        const decoded = jwt.verify(socket.handshake.auth.token, process.env.JWT_SECRET);
        const user = await User.findById(decoded.id);
        if (!user) return next(new Error("Unauthorized"));
        socket.user = { id: user._id.toString(), role: user.role };
        next();
    } catch (error) {
        next(new Error("Unauthorized"));
    }
});

io.on("connection", (socket) => {
    socket.join(`user:${socket.user.id}`);
    if (["admin", "organizer"].includes(socket.user.role)) socket.join("admins");
    socket.on("join-expo", (expoId) => socket.join(`expo:${expoId}`));
    socket.on("leave-expo", (expoId) => socket.leave(`expo:${expoId}`));
});

const emitToExpo = (expoId, event, data) => io.to(`expo:${expoId}`).emit(event, data);
const emitToUser = (userId, event, data) => io.to(`user:${userId}`).emit(event, data);
const emitToAdmins = (event, data) => io.to("admins").emit(event, data);

// create DB notification + push it live
const notifyUser = async (userId, title, message) => {
    const n = await Notification.create({ userId, title, message });
    emitToUser(userId, "new-notification", n);
};


// ================= HELPERS & MIDDLEWARE =================

// common error response (handles invalid ObjectId / duplicate key nicely)
const sendError = (res, text, error) => {
    console.log(text, error.message);
    if (error.name === "CastError") return res.status(400).json({ message: "Invalid id" });
    if (error.code === 11000) return res.status(400).json({ message: "Duplicate entry" });
    if (error.name === "ValidationError") return res.status(400).json({ message: error.message });
    res.status(500).json({ message: text, error: error.message });
};

// verify JWT -> req.user
const verifyToken = async (req, res, next) => {
    try {
        const header = req.headers.authorization;
        if (!header || !header.startsWith("Bearer ")) {
            return res.status(401).json({ message: "Access denied. Token missing" });
        }
        const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
        const user = await User.findById(decoded.id).select("-password -resetToken -resetTokenExpiry");
        if (!user) return res.status(401).json({ message: "User no longer exists" });
        req.user = user;
        next();
    } catch (error) {
        res.status(401).json({ message: "Invalid or expired token" });
    }
};

// like verifyToken but does not block guests
const optionalAuth = async (req, res, next) => {
    try {
        const header = req.headers.authorization;
        if (header && header.startsWith("Bearer ")) {
            const decoded = jwt.verify(header.split(" ")[1], process.env.JWT_SECRET);
            req.user = await User.findById(decoded.id).select("-password");
        }
    } catch (error) { /* ignore */ }
    next();
};

// role check: authorizeRoles("admin", "organizer")
const authorizeRoles = (...roles) => (req, res, next) => {
    if (!roles.includes(req.user.role)) {
        return res.status(403).json({ message: "You do not have permission to do this" });
    }
    next();
};

const staff = authorizeRoles("admin", "organizer");
const exhibitorOnly = authorizeRoles("exhibitor");

const escapeRegex = (text) => String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const escapeHtml = (text) => String(text).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// tell admins when a new user registers (in-app + email), never blocks registration
const notifyAdminsNewUser = async (newUser) => {
    try {
        const text = `${newUser.name} (${newUser.email}) registered as ${newUser.role}.`;

        // in-app notification for every admin / organizer
        const admins = await User.find({
            role: { $in: ["admin", "organizer"] },
            _id: { $ne: newUser._id }
        });
        await Promise.all(admins.map((a) => notifyUser(a._id, "New user registered", text)));

        // email to EMAIL_ADMIN
        if (process.env.EMAIL_ADMIN && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            const transporter = nodemailer.createTransport({
                service: "gmail",
                auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
            });

            await transporter.sendMail({
                from: process.env.EMAIL_USER,
                to: process.env.EMAIL_ADMIN,
                subject: "EventSphere: New user registered",
                html: `
                    <h2>New Registration</h2>
                    <p><b>Name:</b> ${escapeHtml(newUser.name)}</p>
                    <p><b>Email:</b> ${escapeHtml(newUser.email)}</p>
                    <p><b>Role:</b> ${escapeHtml(newUser.role)}</p>
                    <p><b>Time:</b> ${new Date().toLocaleString()}</p>
                `
            });
        }
    } catch (error) {
        console.log("Admin notification error:", error.message);
    }
};


// ==================================================
//                  USER REGISTRATION
// ==================================================

app.post("/register", async (req, res) => {

    try {

        const { name, email, password, role, consent, adminCode } = req.body;


        // Check if all fields are provided

        if (!name || !email || !password) {

            return res.status(400).json({
                message: "Name, email and password are required"
            });

        }

        if (password.length < 6) {

            return res.status(400).json({
                message: "Password must be at least 6 characters"
            });

        }


        // Only people with the secret code can become admin / organizer

        if (["admin", "organizer"].includes(role)) {

            if (!process.env.ADMIN_SIGNUP_CODE || adminCode !== process.env.ADMIN_SIGNUP_CODE) {

                return res.status(403).json({
                    message: "Invalid organizer signup code"
                });

            }

        }


        // Check if user already exists

        const existingUser = await User.findOne({ email: email.toLowerCase() });

        if (existingUser) {

            return res.status(400).json({
                message: "User already exists"
            });

        }


        // Hash the password

        const hashedPassword = await bcrypt.hash(password, 10);


        // Create new user

        const newUser = new User({

            name: name,

            email: email,

            password: hashedPassword,

            role: role || "attendee",

            consent: consent === true

        });


        // Save user to MongoDB

        await newUser.save();


        // Exhibitors get an empty profile ready to edit

        if (newUser.role === "exhibitor") {
            await ExhibitorProfile.create({ userId: newUser._id, contactEmail: newUser.email, companyName: newUser.name });
        }


        notifyAdminsNewUser(newUser);   // alert admins (no await on purpose)


        res.status(201).json({

            message: "User registered successfully",

            user: {
                id: newUser._id,
                name: newUser.name,
                email: newUser.email,
                role: newUser.role
            }

        });

    }

    catch (error) {

        console.log("Registration Error:", error);

        res.status(500).json({
            message: "Something went wrong"
        });

    }

});



// ==================================================
//                     USER LOGIN
// ==================================================

app.post("/login", async (req, res) => {

    try {

        const { email, password } = req.body;


        // Check if email and password are provided

        if (!email || !password) {

            return res.status(400).json({
                message: "Email and password are required"
            });

        }


        // Find user by email

        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {

            return res.status(404).json({
                message: "User not found"
            });

        }


        // Compare entered password with hashed password

        const passwordMatch = await bcrypt.compare(
            password,
            user.password
        );


        if (!passwordMatch) {

            return res.status(401).json({
                message: "Invalid password"
            });

        }


        // Create JWT token

        const token = jwt.sign(

            {
                id: user._id,
                role: user.role
            },

            process.env.JWT_SECRET,

            {
                expiresIn: "1d"
            }

        );


        // Send response

        res.status(200).json({

            message: "Login successful",

            token: token,

            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                role: user.role
            }

        });

    }

    catch (error) {

        console.log("Login Error:", error);

        res.status(500).json({
            message: "Something went wrong"
        });

    }

});


// GET LOGGED-IN USER
app.get("/api/me", verifyToken, (req, res) => {
    res.status(200).json({ user: req.user });
});



// ==================================================
//                  FORGOT PASSWORD
// ==================================================

app.post("/forgot-password", async (req, res) => {

    try {

        const { email } = req.body;


        // Check email

        if (!email) {

            return res.status(400).json({
                message: "Email is required"
            });

        }


        // Find user

        const user = await User.findOne({ email: email.toLowerCase() });

        if (!user) {

            return res.status(404).json({
                message: "User not found"
            });

        }


        // Create reset token

        const resetToken = jwt.sign(

            {
                id: user._id
            },

            process.env.JWT_SECRET,

            {
                expiresIn: "15m"
            }

        );


        // Save reset token in database

        user.resetToken = resetToken;

        user.resetTokenExpiry = Date.now() + 15 * 60 * 1000;

        await user.save();


        // Create email transporter

        const transporter = nodemailer.createTransport({

            service: "gmail",

            auth: {

                user: process.env.EMAIL_USER,

                pass: process.env.EMAIL_PASS

            }

        });


        // Reset password link

        const resetLink =
            `${process.env.CLIENT_URL || "http://localhost:5173"}/reset-password/${resetToken}`;


        // Send email

        await transporter.sendMail({

            from: process.env.EMAIL_USER,

            to: user.email,

            subject: "EventSphere Password Reset",

            html: `

                <h2>EventSphere Password Reset</h2>

                <p>Hello ${user.name},</p>

                <p>You requested to reset your password.</p>

                <p>Click the link below to reset your password:</p>

                <a href="${resetLink}">
                    Reset Password
                </a>

                <p>This link will expire in 15 minutes.</p>

            `

        });


        res.status(200).json({

            message: "Password reset link sent to your email"

        });

    }

    catch (error) {

        console.log("Forgot Password Error:", error);

        res.status(500).json({

            message: "Something went wrong"

        });

    }

});



// ==================================================
//                  RESET PASSWORD
// ==================================================

app.post("/reset-password/:token", async (req, res) => {

    try {

        const { token } = req.params;

        const { password } = req.body;


        // Check password

        if (!password) {

            return res.status(400).json({

                message: "New password is required"

            });

        }


        // Find user with reset token

        const user = await User.findOne({

            resetToken: token,

            resetTokenExpiry: {
                $gt: Date.now()
            }

        });


        if (!user) {

            return res.status(400).json({

                message: "Invalid or expired reset token"

            });

        }


        // Verify JWT token

        try {

            jwt.verify(
                token,
                process.env.JWT_SECRET
            );

        }

        catch (error) {

            return res.status(400).json({

                message: "Invalid or expired reset token"

            });

        }


        // Hash new password

        const hashedPassword = await bcrypt.hash(
            password,
            10
        );


        // Update password

        user.password = hashedPassword;


        // Remove reset token

        user.resetToken = null;

        user.resetTokenExpiry = null;


        await user.save();


        res.status(200).json({

            message: "Password reset successfully"

        });

    }

    catch (error) {

        console.log("Reset Password Error:", error);

        res.status(500).json({

            message: "Something went wrong"

        });

    }

});


// CHANGE PASSWORD (logged-in user)
app.put("/api/change-password", verifyToken, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;

        if (!currentPassword || !newPassword || newPassword.length < 6) {
            return res.status(400).json({ message: "Current password and a new password (min 6 chars) are required" });
        }

        const user = await User.findById(req.user._id);
        if (!(await bcrypt.compare(currentPassword, user.password))) {
            return res.status(401).json({ message: "Current password is incorrect" });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        await user.save();

        res.status(200).json({ message: "Password changed successfully" });
    } catch (error) {
        sendError(res, "Error changing password", error);
    }
});



// ==================================================
//            EXPO MANAGEMENT (ADMIN / ORGANIZER)
// ==================================================

// CREATE EXPO
app.post("/api/expos", verifyToken, staff, async (req, res) => {
    try {
        const { title, description, theme, location, startDate, endDate, floorPlanImage, status } = req.body;

        if (!title || !location || !startDate || !endDate) {
            return res.status(400).json({ message: "Title, location, startDate and endDate are required" });
        }

        const expo = await Expo.create({
            title, description, theme, location, startDate, endDate, floorPlanImage, status,
            createdBy: req.user._id
        });

        res.status(201).json({ message: "Expo created successfully", expo });
    } catch (error) {
        sendError(res, "Error creating expo", error);
    }
});

// GET ALL EXPOS (public; ?search=&upcoming=true)
app.get("/api/expos", optionalAuth, async (req, res) => {
    try {
        const filter = {};
        const isStaff = req.user && ["admin", "organizer"].includes(req.user.role);
        if (!isStaff) filter.status = { $ne: "draft" };
        if (req.query.search) filter.title = new RegExp(escapeRegex(req.query.search), "i");
        if (req.query.upcoming === "true") filter.endDate = { $gte: new Date() };

        const expos = await Expo.find(filter).sort({ startDate: 1 });
        res.status(200).json({ expos });
    } catch (error) {
        sendError(res, "Error fetching expos", error);
    }
});

// GET ONE EXPO
app.get("/api/expos/:id", async (req, res) => {
    try {
        const expo = await Expo.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true });
        if (!expo) return res.status(404).json({ message: "Expo not found" });
        res.status(200).json({ expo });
    } catch (error) {
        sendError(res, "Error fetching expo", error);
    }
});

// UPDATE EXPO
app.put("/api/expos/:id", verifyToken, staff, async (req, res) => {
    try {
        const { title, description, theme, location, startDate, endDate, floorPlanImage, status } = req.body;

        const expo = await Expo.findByIdAndUpdate(
            req.params.id,
            { title, description, theme, location, startDate, endDate, floorPlanImage, status },
            { new: true, runValidators: true }
        );
        if (!expo) return res.status(404).json({ message: "Expo not found" });

        emitToExpo(expo._id, "expo-updated", expo);
        res.status(200).json({ message: "Expo updated successfully", expo });
    } catch (error) {
        sendError(res, "Error updating expo", error);
    }
});

// DELETE EXPO (+ everything linked to it)
app.delete("/api/expos/:id", verifyToken, staff, async (req, res) => {
    try {
        const expo = await Expo.findByIdAndDelete(req.params.id);
        if (!expo) return res.status(404).json({ message: "Expo not found" });

        await Promise.all([
            Booth.deleteMany({ expoId: expo._id }),
            Application.deleteMany({ expoId: expo._id }),
            Session.deleteMany({ expoId: expo._id }),
            Registration.deleteMany({ expoId: expo._id })
        ]);

        res.status(200).json({ message: "Expo and related data deleted successfully" });
    } catch (error) {
        sendError(res, "Error deleting expo", error);
    }
});

// REGISTER FOR AN EXPO (attendee)
app.post("/api/expos/:id/register", verifyToken, async (req, res) => {
    try {
        const expo = await Expo.findById(req.params.id);
        if (!expo) return res.status(404).json({ message: "Expo not found" });

        const registration = await Registration.findOneAndUpdate(
            { userId: req.user._id, expoId: expo._id, sessionId: null, type: "registration" },
            {},
            { upsert: true, new: true }
        );

        emitToAdmins("analytics-update", { expoId: expo._id, event: "expo-registration" });
        res.status(201).json({ message: "Registered for expo successfully", registration });
    } catch (error) {
        sendError(res, "Error registering for expo", error);
    }
});



// ================= BOOTH MANAGEMENT ===================

// CREATE BOOTH
app.post("/api/booths", verifyToken, staff, async (req, res) => {
  try {
    const {
      expoId,
      boothNumber,
      size,
      location,
      price,
      features,
      position
    } = req.body;

    if (!expoId || !boothNumber || !size || !location || price === undefined) {
      return res.status(400).json({
        message: "Please provide all required booth details"
      });
    }

    const existingBooth = await Booth.findOne({
      expoId,
      boothNumber
    });

    if (existingBooth) {
      return res.status(400).json({
        message: "This booth number already exists for this expo"
      });
    }

    const booth = new Booth({
      expoId,
      boothNumber,
      size,
      location,
      price,
      features,
      position
    });

    await booth.save();

    emitToExpo(expoId, "booth-updated", booth);

    res.status(201).json({
      message: "Booth created successfully",
      booth
    });

  } catch (error) {
    sendError(res, "Error creating booth", error);
  }
});

// GET ALL BOOTHS
app.get("/api/booths", async (req, res) => {
  try {
    const booths = await Booth.find()
      .populate("expoId")
      .populate("exhibitorId", "name email");

    res.status(200).json({
      booths
    });

  } catch (error) {
    sendError(res, "Error fetching booths", error);
  }
});

// GET BOOTHS FOR A SPECIFIC EXPO (floor plan)   ?status=available
app.get("/api/booths/expo/:expoId", async (req, res) => {
  try {
    const filter = { expoId: req.params.expoId };
    if (req.query.status) filter.status = req.query.status;

    const booths = await Booth.find(filter)
      .populate("exhibitorId", "name email")
      .sort({ boothNumber: 1 });

    res.status(200).json({
      booths
    });

  } catch (error) {
    sendError(res, "Error fetching expo booths", error);
  }
});

// GET MY BOOTHS (exhibitor)
app.get("/api/booths/my/list", verifyToken, exhibitorOnly, async (req, res) => {
  try {
    const booths = await Booth.find({ exhibitorId: req.user._id }).populate("expoId", "title startDate");
    res.status(200).json({ booths });
  } catch (error) {
    sendError(res, "Error fetching your booths", error);
  }
});

// GET ONE BOOTH (also counts a booth visit for analytics)
app.get("/api/booths/:id", async (req, res) => {
  try {
    const booth = await Booth.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }, { new: true })
      .populate("expoId")
      .populate("exhibitorId", "name email");

    if (!booth) {
      return res.status(404).json({
        message: "Booth not found"
      });
    }

    res.status(200).json({
      booth
    });

  } catch (error) {
    sendError(res, "Error fetching booth", error);
  }
});

// UPDATE BOOTH
app.put("/api/booths/:id", verifyToken, staff, async (req, res) => {
  try {
    const {
      boothNumber,
      size,
      location,
      price,
      features,
      position
    } = req.body;

    const booth = await Booth.findByIdAndUpdate(
      req.params.id,
      {
        boothNumber,
        size,
        location,
        price,
        features,
        position
      },
      {
        new: true,
        runValidators: true
      }
    );

    if (!booth) {
      return res.status(404).json({
        message: "Booth not found"
      });
    }

    emitToExpo(booth.expoId, "booth-updated", booth);

    res.status(200).json({
      message: "Booth updated successfully",
      booth
    });

  } catch (error) {
    sendError(res, "Error updating booth", error);
  }
});

// DELETE BOOTH
app.delete("/api/booths/:id", verifyToken, staff, async (req, res) => {
  try {
    const booth = await Booth.findByIdAndDelete(req.params.id);

    if (!booth) {
      return res.status(404).json({
        message: "Booth not found"
      });
    }

    emitToExpo(booth.expoId, "booth-updated", { _id: booth._id, deleted: true });

    res.status(200).json({
      message: "Booth deleted successfully"
    });

  } catch (error) {
    sendError(res, "Error deleting booth", error);
  }
});

// ASSIGN BOOTH TO EXHIBITOR (admin / organizer)
app.put("/api/booths/:id/assign", verifyToken, staff, async (req, res) => {
  try {
    const { exhibitorId } = req.body;

    if (!exhibitorId) {
      return res.status(400).json({
        message: "Exhibitor ID is required"
      });
    }

    const booth = await Booth.findById(req.params.id);

    if (!booth) {
      return res.status(404).json({
        message: "Booth not found"
      });
    }

    // available, or reserved by this same exhibitor (confirming a reservation)
    const reservedBySame = booth.status === "reserved" && String(booth.exhibitorId) === String(exhibitorId);

    if (booth.status !== "available" && !reservedBySame) {
      return res.status(400).json({
        message: "Booth is not available"
      });
    }

    booth.exhibitorId = exhibitorId;
    booth.status = "occupied";

    await booth.save();

    emitToExpo(booth.expoId, "booth-updated", booth);
    await notifyUser(exhibitorId, "Booth assigned", `Booth ${booth.boothNumber} has been assigned to you.`);

    res.status(200).json({
      message: "Booth assigned successfully",
      booth
    });

  } catch (error) {
    sendError(res, "Error assigning booth", error);
  }
});

// RESERVE BOOTH (exhibitor) - needs an approved application, atomic so no double booking
app.put("/api/booths/:id/reserve", verifyToken, exhibitorOnly, async (req, res) => {
  try {
    const probe = await Booth.findById(req.params.id);

    if (!probe) {
      return res.status(404).json({
        message: "Booth not found"
      });
    }

    const approved = await Application.findOne({
      expoId: probe.expoId,
      exhibitorId: req.user._id,
      status: "approved"
    });

    if (!approved) {
      return res.status(403).json({
        message: "You need an approved application for this expo to reserve a booth"
      });
    }

    const booth = await Booth.findOneAndUpdate(
      { _id: probe._id, status: "available" },
      { status: "reserved", exhibitorId: req.user._id },
      { new: true }
    );

    if (!booth) {
      return res.status(409).json({
        message: "Booth is no longer available"
      });
    }

    emitToExpo(booth.expoId, "booth-updated", booth);

    res.status(200).json({
      message: "Booth reserved successfully",
      booth
    });

  } catch (error) {
    sendError(res, "Error reserving booth", error);
  }
});

// UPDATE MY BOOTH DETAILS (exhibitor: products, description, staff)
app.put("/api/booths/:id/details", verifyToken, exhibitorOnly, async (req, res) => {
  try {
    const { description, products, staff: staffList } = req.body;

    const booth = await Booth.findOneAndUpdate(
      { _id: req.params.id, exhibitorId: req.user._id },
      { details: { description, products, staff: staffList } },
      { new: true }
    );

    if (!booth) {
      return res.status(404).json({
        message: "Booth not found or not yours"
      });
    }

    emitToExpo(booth.expoId, "booth-updated", booth);

    res.status(200).json({
      message: "Booth details updated successfully",
      booth
    });

  } catch (error) {
    sendError(res, "Error updating booth details", error);
  }
});

// RELEASE BOOTH (admin / organizer, or the exhibitor who holds it)
app.put("/api/booths/:id/release", verifyToken, async (req, res) => {
  try {
    const booth = await Booth.findById(req.params.id);

    if (!booth) {
      return res.status(404).json({
        message: "Booth not found"
      });
    }

    const isStaff = ["admin", "organizer"].includes(req.user.role);
    const isOwner = String(booth.exhibitorId) === String(req.user._id);

    if (!isStaff && !isOwner) {
      return res.status(403).json({
        message: "You do not have permission to release this booth"
      });
    }

    booth.exhibitorId = null;
    booth.status = "available";

    await booth.save();

    emitToExpo(booth.expoId, "booth-updated", booth);

    res.status(200).json({
      message: "Booth released successfully",
      booth
    });

  } catch (error) {
    sendError(res, "Error releasing booth", error);
  }
});



// ==================================================
//        EXHIBITOR PROFILE & APPLICATIONS
// ==================================================

// GET MY PROFILE
app.get("/api/exhibitors/profile", verifyToken, exhibitorOnly, async (req, res) => {
    try {
        const profile = await ExhibitorProfile.findOneAndUpdate(
            { userId: req.user._id }, {}, { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        res.status(200).json({ profile });
    } catch (error) {
        sendError(res, "Error fetching profile", error);
    }
});

// UPDATE MY PROFILE (logo, description, contact info, documents are URLs)
app.put("/api/exhibitors/profile", verifyToken, exhibitorOnly, async (req, res) => {
    try {
        const { companyName, description, logo, website, contactEmail, phone, category, products, documents } = req.body;

        const profile = await ExhibitorProfile.findOneAndUpdate(
            { userId: req.user._id },
            { companyName, description, logo, website, contactEmail, phone, category, products, documents },
            { upsert: true, new: true, runValidators: true }
        );
        res.status(200).json({ message: "Profile updated successfully", profile });
    } catch (error) {
        sendError(res, "Error updating profile", error);
    }
});

// APPLY FOR AN EXPO (exhibitor)
app.post("/api/applications", verifyToken, exhibitorOnly, async (req, res) => {
    try {
        const { expoId, companyName, description, category, products, documents } = req.body;

        if (!expoId || !companyName) {
            return res.status(400).json({ message: "expoId and companyName are required" });
        }
        if (!(await Expo.exists({ _id: expoId }))) {
            return res.status(404).json({ message: "Expo not found" });
        }

        const existing = await Application.findOne({ expoId, exhibitorId: req.user._id });
        if (existing) {
            return res.status(400).json({ message: "You have already applied for this expo" });
        }

        const application = await Application.create({
            expoId, exhibitorId: req.user._id, companyName, description, category, products, documents
        });

        emitToAdmins("analytics-update", { expoId, event: "new-application" });
        res.status(201).json({ message: "Application submitted successfully", application });
    } catch (error) {
        sendError(res, "Error submitting application", error);
    }
});

// MY APPLICATIONS (exhibitor)
app.get("/api/applications/my", verifyToken, exhibitorOnly, async (req, res) => {
    try {
        const applications = await Application.find({ exhibitorId: req.user._id }).populate("expoId", "title startDate");
        res.status(200).json({ applications });
    } catch (error) {
        sendError(res, "Error fetching applications", error);
    }
});

// ALL APPLICATIONS (admin)   ?expoId=&status=pending
app.get("/api/applications", verifyToken, staff, async (req, res) => {
    try {
        const filter = {};
        if (req.query.expoId) filter.expoId = req.query.expoId;
        if (req.query.status) filter.status = req.query.status;

        const applications = await Application.find(filter)
            .populate("exhibitorId", "name email")
            .populate("expoId", "title")
            .sort({ createdAt: -1 });
        res.status(200).json({ applications });
    } catch (error) {
        sendError(res, "Error fetching applications", error);
    }
});

// APPROVE / REJECT APPLICATION (admin)
app.put("/api/applications/:id/status", verifyToken, staff, async (req, res) => {
    try {
        const { status, adminNote } = req.body;

        if (!["approved", "rejected"].includes(status)) {
            return res.status(400).json({ message: "Status must be 'approved' or 'rejected'" });
        }

        const application = await Application.findByIdAndUpdate(
            req.params.id,
            { status, adminNote, reviewedBy: req.user._id },
            { new: true }
        );
        if (!application) return res.status(404).json({ message: "Application not found" });

        await notifyUser(
            application.exhibitorId,
            `Application ${status}`,
            adminNote || `Your expo application has been ${status}.`
        );

        res.status(200).json({ message: `Application ${status} successfully`, application });
    } catch (error) {
        sendError(res, "Error updating application", error);
    }
});

// SEARCH / FILTER EXHIBITORS OF AN EXPO (attendee)   ?search=&category=
app.get("/api/expos/:expoId/exhibitors", async (req, res) => {
    try {
        const { search, category } = req.query;
        const filter = { expoId: req.params.expoId, status: "approved" };
        if (category) filter.category = category;
        if (search) {
            const rx = new RegExp(escapeRegex(search), "i");
            filter.$or = [{ companyName: rx }, { description: rx }, { products: rx }, { category: rx }];
        }

        const applications = await Application.find(filter);
        const ids = applications.map((a) => a.exhibitorId);

        const [booths, profiles] = await Promise.all([
            Booth.find({ expoId: req.params.expoId, exhibitorId: { $in: ids } }).select("boothNumber location position"),
            ExhibitorProfile.find({ userId: { $in: ids } })
        ]);

        const exhibitors = applications.map((a) => ({
            exhibitorId: a.exhibitorId,
            companyName: a.companyName,
            category: a.category,
            products: a.products,
            description: a.description,
            profile: profiles.find((p) => String(p.userId) === String(a.exhibitorId)) || null,
            booths: booths.filter((b) => String(b.exhibitorId) === String(a.exhibitorId))
        }));

        res.status(200).json({ exhibitors });
    } catch (error) {
        sendError(res, "Error searching exhibitors", error);
    }
});



// ==================================================
//               SCHEDULE / SESSIONS
// ==================================================

// CREATE SESSION (admin)
app.post("/api/sessions", verifyToken, staff, async (req, res) => {
    try {
        const { expoId, title, topic, description, speaker, location, startTime, endTime, capacity } = req.body;

        if (!expoId || !title || !startTime || !endTime) {
            return res.status(400).json({ message: "expoId, title, startTime and endTime are required" });
        }
        if (new Date(endTime) <= new Date(startTime)) {
            return res.status(400).json({ message: "endTime must be after startTime" });
        }

        const session = await Session.create({ expoId, title, topic, description, speaker, location, startTime, endTime, capacity });

        emitToExpo(expoId, "schedule-updated", { action: "created", session });
        res.status(201).json({ message: "Session created successfully", session });
    } catch (error) {
        sendError(res, "Error creating session", error);
    }
});

// GET SESSIONS   ?expoId=&day=2026-11-05&speaker=
app.get("/api/sessions", async (req, res) => {
    try {
        const filter = {};
        if (req.query.expoId) filter.expoId = req.query.expoId;
        if (req.query.speaker) filter.speaker = new RegExp(escapeRegex(req.query.speaker), "i");
        if (req.query.day) {
            const start = new Date(req.query.day);
            filter.startTime = { $gte: start, $lt: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
        }

        const sessions = await Session.find(filter).sort({ startTime: 1 });
        res.status(200).json({ sessions });
    } catch (error) {
        sendError(res, "Error fetching sessions", error);
    }
});

// MY REGISTRATIONS & BOOKMARKS
app.get("/api/registrations/my", verifyToken, async (req, res) => {
    try {
        const registrations = await Registration.find({ userId: req.user._id })
            .populate("expoId", "title startDate location")
            .populate("sessionId");
        res.status(200).json({ registrations });
    } catch (error) {
        sendError(res, "Error fetching registrations", error);
    }
});

// GET ONE SESSION
app.get("/api/sessions/:id", async (req, res) => {
    try {
        const session = await Session.findById(req.params.id);
        if (!session) return res.status(404).json({ message: "Session not found" });
        res.status(200).json({ session });
    } catch (error) {
        sendError(res, "Error fetching session", error);
    }
});

// UPDATE SESSION (admin) - registered users get notified
app.put("/api/sessions/:id", verifyToken, staff, async (req, res) => {
    try {
        const { title, topic, description, speaker, location, startTime, endTime, capacity } = req.body;

        const session = await Session.findByIdAndUpdate(
            req.params.id,
            { title, topic, description, speaker, location, startTime, endTime, capacity },
            { new: true, runValidators: true }
        );
        if (!session) return res.status(404).json({ message: "Session not found" });

        emitToExpo(session.expoId, "schedule-updated", { action: "updated", session });

        const regs = await Registration.find({ sessionId: session._id });
        await Promise.all(regs.map((r) =>
            notifyUser(r.userId, "Session updated", `"${session.title}" was updated. Please check the latest time and location.`)
        ));

        res.status(200).json({ message: "Session updated successfully", session });
    } catch (error) {
        sendError(res, "Error updating session", error);
    }
});

// DELETE SESSION (admin)
app.delete("/api/sessions/:id", verifyToken, staff, async (req, res) => {
    try {
        const session = await Session.findByIdAndDelete(req.params.id);
        if (!session) return res.status(404).json({ message: "Session not found" });

        await Registration.deleteMany({ sessionId: session._id });
        emitToExpo(session.expoId, "schedule-updated", { action: "deleted", sessionId: session._id });

        res.status(200).json({ message: "Session deleted successfully" });
    } catch (error) {
        sendError(res, "Error deleting session", error);
    }
});

// REGISTER / BOOKMARK a session
const addToSession = (type) => async (req, res) => {
    try {
        const session = await Session.findById(req.params.id);
        if (!session) return res.status(404).json({ message: "Session not found" });

        if (type === "registration" && session.capacity) {
            const count = await Registration.countDocuments({ sessionId: session._id, type: "registration" });
            if (count >= session.capacity) {
                return res.status(409).json({ message: "Session is full" });
            }
        }

        const registration = await Registration.findOneAndUpdate(
            { userId: req.user._id, expoId: session.expoId, sessionId: session._id, type },
            {},
            { upsert: true, new: true }
        );

        emitToAdmins("analytics-update", { expoId: session.expoId, event: `session-${type}` });
        res.status(201).json({ message: `Session ${type === "bookmark" ? "bookmarked" : "registered"} successfully`, registration });
    } catch (error) {
        sendError(res, "Error saving session choice", error);
    }
};

const removeFromSession = (type) => async (req, res) => {
    try {
        await Registration.deleteOne({ userId: req.user._id, sessionId: req.params.id, type });
        res.status(200).json({ message: "Removed successfully" });
    } catch (error) {
        sendError(res, "Error removing session choice", error);
    }
};

app.post("/api/sessions/:id/register", verifyToken, addToSession("registration"));
app.delete("/api/sessions/:id/register", verifyToken, removeFromSession("registration"));
app.post("/api/sessions/:id/bookmark", verifyToken, addToSession("bookmark"));
app.delete("/api/sessions/:id/bookmark", verifyToken, removeFromSession("bookmark"));



// ==================================================
//        MESSAGING (chat between users)
// ==================================================

// SEND MESSAGE
app.post("/api/messages", verifyToken, async (req, res) => {
    try {
        const { receiverId, text } = req.body;

        if (!receiverId || !text) {
            return res.status(400).json({ message: "receiverId and text are required" });
        }

        const receiver = await User.findById(receiverId);
        if (!receiver) return res.status(404).json({ message: "Receiver not found" });

        if (req.user.role === "attendee" && receiver.role === "attendee") {
            return res.status(403).json({ message: "Attendees can only message exhibitors or organizers" });
        }

        const message = await Message.create({ senderId: req.user._id, receiverId, text: text.slice(0, 2000) });

        emitToUser(receiverId, "new-message", message);
        res.status(201).json({ message: "Message sent", data: message });
    } catch (error) {
        sendError(res, "Error sending message", error);
    }
});

// INBOX (latest message per conversation)
app.get("/api/messages/inbox", verifyToken, async (req, res) => {
    try {
        const me = String(req.user._id);
        const msgs = await Message.find({ $or: [{ senderId: me }, { receiverId: me }] })
            .sort({ createdAt: -1 }).limit(500)
            .populate("senderId receiverId", "name role");

        const seen = new Map();
        msgs.forEach((m) => {
            const peer = String(m.senderId._id) === me ? m.receiverId : m.senderId;
            const key = String(peer._id);
            if (!seen.has(key)) seen.set(key, { peer, lastMessage: m, unread: 0 });
            if (String(m.receiverId._id) === me && !m.read) seen.get(key).unread++;
        });

        res.status(200).json({ conversations: [...seen.values()] });
    } catch (error) {
        sendError(res, "Error fetching inbox", error);
    }
});

// CONVERSATION WITH ONE USER
app.get("/api/messages/:userId", verifyToken, async (req, res) => {
    try {
        const me = req.user._id;
        const other = req.params.userId;

        await Message.updateMany({ senderId: other, receiverId: me, read: false }, { read: true });

        const messages = await Message.find({
            $or: [{ senderId: me, receiverId: other }, { senderId: other, receiverId: me }]
        }).sort({ createdAt: 1 });

        res.status(200).json({ messages });
    } catch (error) {
        sendError(res, "Error fetching conversation", error);
    }
});



// ==================================================
//             NOTIFICATIONS
// ==================================================

app.get("/api/notifications", verifyToken, async (req, res) => {
    try {
        const notifications = await Notification.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(100);
        res.status(200).json({ notifications });
    } catch (error) {
        sendError(res, "Error fetching notifications", error);
    }
});

app.put("/api/notifications/read", verifyToken, async (req, res) => {
    try {
        await Notification.updateMany({ userId: req.user._id, read: false }, { read: true });
        res.status(200).json({ message: "All notifications marked as read" });
    } catch (error) {
        sendError(res, "Error updating notifications", error);
    }
});



// ==================================================
//             FEEDBACK & SUPPORT
// ==================================================

app.post("/api/feedback", optionalAuth, async (req, res) => {
    try {
        const { type, message } = req.body;
        if (!message) return res.status(400).json({ message: "Message is required" });

        const feedback = await Feedback.create({ userId: req.user ? req.user._id : undefined, type, message });
        res.status(201).json({ message: "Thank you for your feedback", feedback });
    } catch (error) {
        sendError(res, "Error submitting feedback", error);
    }
});

app.get("/api/feedback", verifyToken, staff, async (req, res) => {
    try {
        const feedback = await Feedback.find().populate("userId", "name email").sort({ createdAt: -1 });
        res.status(200).json({ feedback });
    } catch (error) {
        sendError(res, "Error fetching feedback", error);
    }
});

app.put("/api/feedback/:id", verifyToken, staff, async (req, res) => {
    try {
        const feedback = await Feedback.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
        if (!feedback) return res.status(404).json({ message: "Feedback not found" });
        res.status(200).json({ message: "Feedback updated", feedback });
    } catch (error) {
        sendError(res, "Error updating feedback", error);
    }
});



// ==================================================
//             ANALYTICS & REPORTING (admin)
// ==================================================

app.get("/api/analytics/:expoId", verifyToken, staff, async (req, res) => {
    try {
        const expoId = new mongoose.Types.ObjectId(req.params.expoId);

        const [expo, registeredAttendees, applications, booths, topBooths, sessionPopularity, totalSessions] = await Promise.all([
            Expo.findById(expoId).select("title views"),
            Registration.countDocuments({ expoId, sessionId: null, type: "registration" }),
            Application.aggregate([{ $match: { expoId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
            Booth.aggregate([{ $match: { expoId } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
            Booth.find({ expoId }).sort({ views: -1 }).limit(5).select("boothNumber views status"),
            Registration.aggregate([
                { $match: { expoId, sessionId: { $ne: null } } },
                { $group: {
                    _id: "$sessionId",
                    registrations: { $sum: { $cond: [{ $eq: ["$type", "registration"] }, 1, 0] } },
                    bookmarks: { $sum: { $cond: [{ $eq: ["$type", "bookmark"] }, 1, 0] } }
                } },
                { $sort: { registrations: -1, bookmarks: -1 } },
                { $limit: 10 },
                { $lookup: { from: "sessions", localField: "_id", foreignField: "_id", as: "session" } },
                { $unwind: "$session" },
                { $project: { registrations: 1, bookmarks: 1, title: "$session.title" } }
            ]),
            Session.countDocuments({ expoId })
        ]);

        if (!expo) return res.status(404).json({ message: "Expo not found" });

        res.status(200).json({
            expo: { id: expo._id, title: expo.title, pageViews: expo.views },
            attendeeEngagement: { registeredAttendees },
            applicationsByStatus: applications,
            boothsByStatus: booths,
            boothTraffic: topBooths,
            sessionPopularity,
            totalSessions
        });
    } catch (error) {
        sendError(res, "Error generating analytics", error);
    }
});



// ==================================================
//             FILE UPLOAD (CLOUDINARY)
// ==================================================

// UPLOAD A FILE (logo, document, floor plan)
// send multipart/form-data with field name "file"; optional ?folder=logos|documents|floorplans
app.post("/api/upload", verifyToken, (req, res) => {

    upload.single("file")(req, res, async (err) => {

        try {

            if (err) {
                const message = err.code === "LIMIT_FILE_SIZE" ? "File is too large (max 5MB)" : err.message;
                return res.status(400).json({ message });
            }

            if (!req.file) {
                return res.status(400).json({ message: "No file uploaded. Use form field name 'file'" });
            }

            const folder = ["logos", "documents", "floorplans"].includes(req.query.folder) ? req.query.folder : "general";

            let url = null;
            let storage = "cloudinary";
            let warning;

            // 1) try Cloudinary
            if (cloudinaryReady()) {
                try {
                    const result = await uploadToCloudinary(req.file.buffer, folder);
                    url = result.secure_url;
                } catch (cloudError) {
                    console.log("Cloudinary upload failed:", cloudError.message || cloudError);
                    warning = `Cloudinary failed (${cloudError.message || "unknown error"}). Saved on the server instead.`;
                }
            }

            // 2) fallback: save on this server (always works locally)
            if (!url) {
                url = saveLocally(req.file, req);
                storage = "local";
                warning = warning || "Cloudinary is not configured. Saved on the server instead.";
            }

            res.status(201).json({
                message: "File uploaded successfully",
                name: req.file.originalname,
                url,
                storage,
                warning
            });

        } catch (error) {
            sendError(res, "Error uploading file", error);
        }

    });

});



// ==================================================
//        ACCOUNT, PRIVACY (GDPR) & USER LIST
// ==================================================

// UPDATE MY ACCOUNT (name, consent)
app.put("/api/me", verifyToken, async (req, res) => {
    try {
        const { name, consent } = req.body;
        const update = {};
        if (name) update.name = name;
        if (typeof consent === "boolean") update.consent = consent;

        const user = await User.findByIdAndUpdate(req.user._id, update, { new: true })
            .select("-password -resetToken -resetTokenExpiry");
        res.status(200).json({ message: "Account updated successfully", user });
    } catch (error) {
        sendError(res, "Error updating account", error);
    }
});

// EXPORT ALL MY DATA (GDPR)
app.get("/api/me/export", verifyToken, async (req, res) => {
    try {
        const id = req.user._id;
        const [profile, registrations, applications, messages, feedback, notifications] = await Promise.all([
            ExhibitorProfile.findOne({ userId: id }),
            Registration.find({ userId: id }),
            Application.find({ exhibitorId: id }),
            Message.find({ $or: [{ senderId: id }, { receiverId: id }] }),
            Feedback.find({ userId: id }),
            Notification.find({ userId: id })
        ]);
        res.status(200).json({ user: req.user, profile, registrations, applications, messages, feedback, notifications });
    } catch (error) {
        sendError(res, "Error exporting data", error);
    }
});

// DELETE MY ACCOUNT AND PERSONAL DATA (GDPR)
app.delete("/api/me", verifyToken, async (req, res) => {
    try {
        const id = req.user._id;

        if (["admin", "organizer"].includes(req.user.role)) {
            const staffCount = await User.countDocuments({ role: { $in: ["admin", "organizer"] } });
            if (staffCount <= 1) {
                return res.status(400).json({ message: "You are the last admin/organizer and cannot delete this account" });
            }
        }

        await Promise.all([
            Registration.deleteMany({ userId: id }),
            Notification.deleteMany({ userId: id }),
            Message.deleteMany({ $or: [{ senderId: id }, { receiverId: id }] }),
            ExhibitorProfile.deleteOne({ userId: id }),
            Application.deleteMany({ exhibitorId: id }),
            Feedback.updateMany({ userId: id }, { $unset: { userId: 1 } }),
            Booth.updateMany({ exhibitorId: id }, { status: "available", exhibitorId: null })
        ]);
        await User.deleteOne({ _id: id });

        res.status(200).json({ message: "Account and personal data deleted successfully" });
    } catch (error) {
        sendError(res, "Error deleting account", error);
    }
});

// LIST USERS (admin)   ?role=exhibitor&search=
app.get("/api/users", verifyToken, staff, async (req, res) => {
    try {
        const filter = {};
        if (req.query.role) filter.role = String(req.query.role);
        if (req.query.search) {
            const rx = new RegExp(escapeRegex(req.query.search), "i");
            filter.$or = [{ name: rx }, { email: rx }];
        }
        const users = await User.find(filter).select("-password -resetToken -resetTokenExpiry").sort({ createdAt: -1 });
        res.status(200).json({ users });
    } catch (error) {
        sendError(res, "Error fetching users", error);
    }
});



// ==================================================
//   NEIGHBORING EXHIBITORS & INQUIRIES (COMMUNICATION)
// ==================================================

// generic email helper (never throws)
const sendEmail = async (to, subject, html, replyTo) => {
    try {
        if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return false;
        const transporter = nodemailer.createTransport({
            service: "gmail",
            auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
        });
        await transporter.sendMail({ from: process.env.EMAIL_USER, to, subject, html, replyTo });
        return true;
    } catch (error) {
        console.log("Email error:", error.message);
        return false;
    }
};

// NEIGHBORS OF A BOOTH (same hall, nearest first) with contact info for collaboration
app.get("/api/booths/:id/neighbors", verifyToken, async (req, res) => {
    try {
        const booth = await Booth.findById(req.params.id);
        if (!booth) return res.status(404).json({ message: "Booth not found" });

        const others = await Booth.find({
            expoId: booth.expoId,
            location: booth.location,
            exhibitorId: { $nin: [null, booth.exhibitorId] }
        }).populate("exhibitorId", "name email");

        const distance = (b) => (booth.position && b.position && booth.position.x != null && b.position.x != null)
            ? Math.hypot(b.position.x - booth.position.x, b.position.y - booth.position.y)
            : Infinity;
        const list = others.filter((b) => b.exhibitorId).sort((a, b) => distance(a) - distance(b));

        const profiles = await ExhibitorProfile.find({ userId: { $in: list.map((b) => b.exhibitorId._id) } });

        const neighbors = list.map((b) => {
            const p = profiles.find((x) => String(x.userId) === String(b.exhibitorId._id));
            return {
                boothId: b._id,
                boothNumber: b.boothNumber,
                exhibitor: { id: b.exhibitorId._id, name: b.exhibitorId.name },
                contact: {
                    email: (p && p.contactEmail) || b.exhibitorId.email,
                    phone: p ? p.phone : undefined,
                    website: p ? p.website : undefined
                },
                distance: Number.isFinite(distance(b)) ? Math.round(distance(b)) : null
            };
        });

        res.status(200).json({ neighbors });
    } catch (error) {
        sendError(res, "Error fetching neighbors", error);
    }
});

// SEND INQUIRY / APPOINTMENT REQUEST TO AN EXHIBITOR (chat + notification + email)
app.post("/api/exhibitors/:id/inquiry", verifyToken, async (req, res) => {
    try {
        const { subject, message, preferredTime } = req.body;
        if (!message) return res.status(400).json({ message: "Message is required" });

        const exhibitor = await User.findOne({ _id: req.params.id, role: "exhibitor" });
        if (!exhibitor) return res.status(404).json({ message: "Exhibitor not found" });

        const profile = await ExhibitorProfile.findOne({ userId: exhibitor._id });
        const to = (profile && profile.contactEmail) || exhibitor.email;

        const text = `${subject ? subject + ": " : ""}${message}${preferredTime ? ` (preferred time: ${preferredTime})` : ""}`;
        const chat = await Message.create({ senderId: req.user._id, receiverId: exhibitor._id, text: text.slice(0, 2000) });
        emitToUser(exhibitor._id, "new-message", chat);
        await notifyUser(exhibitor._id, "New inquiry", `${req.user.name}: ${subject || "Inquiry"}`);

        const emailSent = await sendEmail(
            to,
            `EventSphere inquiry: ${subject || "New inquiry"}`,
            `<h3>New inquiry from ${escapeHtml(req.user.name)}</h3>
             <p>${escapeHtml(message)}</p>
             ${preferredTime ? `<p><b>Preferred time:</b> ${escapeHtml(preferredTime)}</p>` : ""}
             <p>Reply to: ${escapeHtml(req.user.email)}</p>`,
            req.user.email
        );

        res.status(201).json({ message: "Inquiry sent successfully", emailSent });
    } catch (error) {
        sendError(res, "Error sending inquiry", error);
    }
});



// ==================================================
//             REPORTS (JSON or CSV download)
// ==================================================

const toCSV = (rows) => {
    if (!rows.length) return "";
    const cols = Object.keys(rows[0]);
    const esc = (v) => `"${String(v === undefined || v === null ? "" : v).replace(/"/g, '""')}"`;
    return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
};

// GET /api/reports/:expoId?type=attendees|booths|sessions|applications&format=csv
app.get("/api/reports/:expoId", verifyToken, staff, async (req, res) => {
    try {
        const type = String(req.query.type || "booths");
        const format = String(req.query.format || "json");
        const expoId = new mongoose.Types.ObjectId(req.params.expoId);
        let rows = [];

        if (type === "attendees") {
            const regs = await Registration.find({ expoId, sessionId: null, type: "registration" }).populate("userId", "name email");
            rows = regs.filter((r) => r.userId).map((r) => ({
                name: r.userId.name, email: r.userId.email, registeredAt: r.createdAt.toISOString()
            }));
        } else if (type === "booths") {
            const booths = await Booth.find({ expoId }).populate("exhibitorId", "name email").sort({ boothNumber: 1 });
            rows = booths.map((b) => ({
                boothNumber: b.boothNumber, location: b.location, status: b.status, price: b.price,
                exhibitor: b.exhibitorId ? b.exhibitorId.name : "", views: b.views
            }));
        } else if (type === "sessions") {
            const sessions = await Session.find({ expoId }).sort({ startTime: 1 });
            const counts = await Registration.aggregate([
                { $match: { expoId, sessionId: { $ne: null } } },
                { $group: { _id: { s: "$sessionId", t: "$type" }, n: { $sum: 1 } } }
            ]);
            const get = (id, t) => (counts.find((c) => String(c._id.s) === String(id) && c._id.t === t) || { n: 0 }).n;
            rows = sessions.map((s) => ({
                title: s.title, speaker: s.speaker || "", location: s.location || "", startTime: s.startTime.toISOString(),
                registrations: get(s._id, "registration"), bookmarks: get(s._id, "bookmark")
            }));
        } else if (type === "applications") {
            const apps = await Application.find({ expoId }).populate("exhibitorId", "name email");
            rows = apps.map((a) => ({
                company: a.companyName, category: a.category || "", status: a.status,
                exhibitor: a.exhibitorId ? a.exhibitorId.email : "", appliedAt: a.createdAt.toISOString()
            }));
        } else {
            return res.status(400).json({ message: "type must be attendees, booths, sessions or applications" });
        }

        if (format === "csv") {
            res.setHeader("Content-Type", "text/csv");
            res.setHeader("Content-Disposition", `attachment; filename="${type}-report.csv"`);
            return res.status(200).send(toCSV(rows));
        }
        res.status(200).json({ type, count: rows.length, rows });
    } catch (error) {
        sendError(res, "Error generating report", error);
    }
});



// ================= HEALTH CHECK =================

app.get("/health", (req, res) => {
    res.status(200).json({ status: "ok", uptime: process.uptime() });
});


// ================= 404 & ERROR HANDLER =================

app.use((req, res) => {
    res.status(404).json({ message: `Route not found: ${req.method} ${req.originalUrl}` });
});

app.use((err, req, res, next) => {
    console.log("Unhandled Error:", err.message);
    if (err.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid JSON body" });
    res.status(500).json({ message: "Something went wrong" });
});


// ================= SESSION REMINDERS =================
// every minute: notify registered/bookmarked users 15 minutes before a session starts

setInterval(async () => {
    try {
        const now = new Date();
        const soon = new Date(now.getTime() + 15 * 60 * 1000);
        const sessions = await Session.find({ startTime: { $gt: now, $lte: soon } });

        for (const s of sessions) {
            const regs = await Registration.find({ sessionId: s._id, reminded: false });
            for (const r of regs) {
                await notifyUser(r.userId, "Session starting soon", `"${s.title}" starts at ${s.startTime.toLocaleString()} (${s.location || "location TBA"}).`);
                r.reminded = true;
                await r.save();
            }
        }
    } catch (error) {
        console.log("Reminder Error:", error.message);
    }
}, 60 * 1000);


// ================= START SERVER =================

server.listen(PORT, () => {

    console.log(`Server running on: ${PORT}`);

});

// graceful shutdown (deployments / restarts)
const shutdown = () => {
    console.log("Shutting down...");
    server.close(async () => {
        await mongoose.connection.close();
        process.exit(0);
    });
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
