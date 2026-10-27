// Usage: npm run backup   (schedule with cron / Task Scheduler for automated backups)
require("dotenv").config();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");

(async () => {
    await mongoose.connect(process.env.MONGO_URL);
    const dir = path.join(__dirname, "..", "backups", new Date().toISOString().replace(/[:.]/g, "-"));
    fs.mkdirSync(dir, { recursive: true });

    const collections = await mongoose.connection.db.listCollections().toArray();
    for (const c of collections) {
        const docs = await mongoose.connection.db.collection(c.name).find().toArray();
        fs.writeFileSync(path.join(dir, `${c.name}.json`), JSON.stringify(docs, null, 2));
        console.log(`Backed up ${c.name} (${docs.length} documents)`);
    }

    console.log(`Backup saved in ${dir}`);
    await mongoose.disconnect();
})().catch((e) => { console.error("Backup failed:", e.message); process.exit(1); });
