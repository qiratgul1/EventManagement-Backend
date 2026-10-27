const mongoose = require("mongoose");

const expoSchema = mongoose.Schema({
    title: { type: String, required: true, trim: true },
    description: String,
    theme: String,
    location: { type: String, required: true },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    floorPlanImage: String,
    status: { type: String, enum: ["draft", "published", "completed"], default: "published" },
    views: { type: Number, default: 0 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" }
}, { timestamps: true });

module.exports = mongoose.model("Expo", expoSchema);
