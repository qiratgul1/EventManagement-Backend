const mongoose = require("mongoose");

const sessionSchema = mongoose.Schema({
    expoId: { type: mongoose.Schema.Types.ObjectId, ref: "Expo", required: true },
    title: { type: String, required: true },
    topic: String,
    description: String,
    speaker: String,
    location: String,
    startTime: { type: Date, required: true },
    endTime: { type: Date, required: true },
    capacity: Number
}, { timestamps: true });

sessionSchema.index({ expoId: 1, startTime: 1 });

module.exports = mongoose.model("Session", sessionSchema);
