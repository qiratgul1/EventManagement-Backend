const mongoose = require("mongoose");

const applicationSchema = mongoose.Schema({
    expoId: { type: mongoose.Schema.Types.ObjectId, ref: "Expo", required: true },
    exhibitorId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
    companyName: { type: String, required: true },
    description: String,
    category: String,
    products: [String],
    documents: [{ name: String, url: String }],
    status: { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    adminNote: String,
    reviewedBy: { type: mongoose.Schema.Types.ObjectId, ref: "user" }
}, { timestamps: true });

applicationSchema.index({ expoId: 1, exhibitorId: 1 }, { unique: true });

applicationSchema.index({ expoId: 1, status: 1 });

module.exports = mongoose.model("Application", applicationSchema);
