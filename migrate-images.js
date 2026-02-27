require("dotenv").config();
const mongoose = require("mongoose");
const cloudinary = require("cloudinary").v2;

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const UserSchema = new mongoose.Schema({
  firstName: String, lastName: String, email: String,
  profilePic: String, backgroundImage: String, coverImage: String,
});
const User = mongoose.model("users", UserSchema);

async function uploadIfBase64(base64, folder) {
  if (!base64) return null;
  if (base64.startsWith("http")) return base64; // already a URL
  try {
    const result = await cloudinary.uploader.upload(base64, { folder, resource_type: "image" });
    return result.secure_url;
  } catch (e) {
    console.error("Upload failed:", e.message);
    return null;
  }
}

async function migrate() {
  await mongoose.connect(process.env.MONGO_URL);
  console.log("✓ Connected to MongoDB");

  const users = await User.find({});
  console.log(`Found ${users.length} users to check`);

  let migrated = 0;

  for (const user of users) {
    const updates = {};

    const profilePic = await uploadIfBase64(user.profilePic, "dispatch/avatars");
    if (profilePic && profilePic !== user.profilePic) updates.profilePic = profilePic;

    const backgroundImage = await uploadIfBase64(user.backgroundImage, "dispatch/backgrounds");
    if (backgroundImage && backgroundImage !== user.backgroundImage) updates.backgroundImage = backgroundImage;

    const coverImage = await uploadIfBase64(user.coverImage, "dispatch/covers");
    if (coverImage && coverImage !== user.coverImage) updates.coverImage = coverImage;

    if (Object.keys(updates).length > 0) {
      await User.updateOne({ _id: user._id }, { $set: updates });
      console.log(`✓ Migrated ${user.firstName} ${user.lastName} (${user._id})`);
      migrated++;
    } else {
      console.log(`- Skipped ${user.firstName} ${user.lastName} (no base64 images)`);
    }

    // Small delay to avoid Cloudinary rate limits
    await new Promise(r => setTimeout(r, 300));
  }

  console.log(`\n✅ Done! Migrated ${migrated}/${users.length} users`);
  mongoose.disconnect();
}

migrate().catch(console.error);