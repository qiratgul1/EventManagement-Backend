const mongoose = require("mongoose");

const boothSchema = mongoose.Schema({
    expoId: { type: mongoose.Schema.Types.ObjectId, ref: "Expo", required: true },
    boothNumber: { type: String, required: true },
    size: { type: String, required: true },
    location: { type: String, required: true },
    price: { type: Number, required: true },
    features: [String],
    position: { x: Number, y: Number, w: Number, h: Number }, // floor-plan coordinates
    status: { type: String, enum: ["available", "reserved", "occupied"], default: "available" },
    exhibitorId: { type: mongoose.Schema.Types.ObjectId, ref: "user", default: null },
    details: {
        description: String,
        products: [String],
        staff: [{ name: String, email: String, phone: String }]
    },
    views: { type: Number, default: 0 }
}, { timestamps: true });

boothSchema.index({ expoId: 1, boothNumber: 1 }, { unique: true });

module.exports = mongoose.model("Booth", boothSchema);
