const mongoose = require("mongoose");

// One model for: expo registration (sessionId null), session registration, session bookmark
const registrationSchema = mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    expoId: { type: mongoose.Schema.Types.ObjectId, ref: "Expo", required: true },
    sessionId: { type: mongoose.Schema.Types.ObjectId, ref: "Session", default: null },
    type: { type: String, enum: ["registration", "bookmark"], default: "registration" },
    reminded: { type: Boolean, default: false }
}, { timestamps: true });

registrationSchema.index({ userId: 1, expoId: 1, sessionId: 1, type: 1 }, { unique: true });

module.exports = mongoose.model("Registration", registrationSchema);
