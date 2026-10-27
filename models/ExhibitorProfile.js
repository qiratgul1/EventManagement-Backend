const mongoose = require("mongoose");

const profileSchema = mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "user", unique: true, required: true },
    companyName: String,
    description: String,
    logo: String,
    website: String,
    contactEmail: String,
    phone: String,
    category: String,
    products: [String],
    documents: [{ name: String, url: String }]
}, { timestamps: true });

module.exports = mongoose.model("ExhibitorProfile", profileSchema);
