const mongoose = require("mongoose");

const feedbackSchema = mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "user" },
    type: { type: String, enum: ["suggestion", "issue", "other"], default: "suggestion" },
    message: { type: String, required: true },
    status: { type: String, enum: ["open", "resolved"], default: "open" }
}, { timestamps: true });

module.exports = mongoose.model("Feedback", feedbackSchema);
