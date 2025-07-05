// === server.js ===
const express = require("express");
const ytdl = require("@distube/ytdl-core");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const { pipeline } = require("stream");

const rateLimit = require("express-rate-limit");

require("dotenv").config();

// Global limiter (apply to all routes)
const globalLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // Max 100 requests per IP per minute
  standardHeaders: true, // Return rate limit info in headers
  legacyHeaders: false, // Disable `X-RateLimit-*` headers
});

// Specific tighter limiter for downloads
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // Max 10 downloads per IP per 15 minutes
  message: "Too many downloads from this IP, please try again later.",
});

const infoLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // Max 100 requests per IP
  message: "Too many requests to /info, please try again in a minute.",
  standardHeaders: true,
  legacyHeaders: false,
});

ffmpeg.setFfmpegPath(ffmpegPath);

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());

app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*"); // or set specific domain
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  next();
});

// Apply global limiter to all routes
app.use(globalLimiter);
app.set("trust proxy", 1);

const QUALITY_MAP = {
  360: { itag: "18", videoAndAudio: true },
  720: { itag: "22", videoAndAudio: true },
  1080: { itag: "137", videoAndAudio: false },
};

function normalizeYouTubeUrl(url) {
  if (url.includes("/shorts/")) {
    const id = url.match(/\/shorts\/([a-zA-Z0-9_-]+)/)?.[1];
    return `https://www.youtube.com/watch?v=${id}`;
  }
  return url;
}
function sanitize(title) {
  // Remove characters not allowed in filenames
  return title.replace(/[^a-zA-Z0-9_\-\. ]/g, "");
}


app.get("/info", infoLimiter, async (req, res) => {
  try {
    const decodedUrl = decodeURIComponent(req.query.url);
    const rawUrl = normalizeYouTubeUrl(decodedUrl);

    console.log("🔍 Decoded URL:", decodedUrl);
    console.log("🔍 Normalized URL:", rawUrl);

    if (!ytdl.validateURL(rawUrl)) {
      console.log("❌ Invalid YouTube URL:", rawUrl);
      return res.status(400).send("Invalid YouTube URL");
    }

    const info = await ytdl.getInfo(rawUrl);
    const details = info.videoDetails;

    const videoInfo = {
      title: details.title,
      thumbnail: details.thumbnails.at(-1)?.url,
      channel: details.author.name,
      duration: `${Math.floor(details.lengthSeconds / 60)}:${
        details.lengthSeconds % 60
      }`,
    };

    console.log("✅ Video Info Fetched:", videoInfo.title);

    res.json(videoInfo);

  } catch (err) {
    console.error("❌ /info error:", err);
    res.status(500).send("Failed to fetch video info");
  }
});

//we added here downloadLimiter middleware.

app.get("/download", downloadLimiter, async (req, res) => {
  try {
    const decodedUrl = decodeURIComponent(req.query.url);
    const rawUrl = normalizeYouTubeUrl(decodedUrl);
    const itag = req.query.quality;
    const type = req.query.type || "video";

    console.log("▶️ Decoded URL:", decodedUrl);
    console.log("▶️ Normalized URL:", rawUrl);
    console.log("▶️ Itag:", itag, "| Type:", type);

    if (!ytdl.validateURL(rawUrl)) {
      console.log("❌ Invalid YouTube URL:", rawUrl);
      return res.status(400).send("Invalid YouTube URL");
    }

    const info = await ytdl.getInfo(rawUrl);
    const format = info.formats.find(f => f.itag.toString() === itag);

    if (!format && type !== "audio") {
      console.log("❌ Unsupported quality/itag:", itag);
      return res.status(400).send("Unsupported quality or itag.");
    }

    const title = sanitize(info.videoDetails.title);
    res.setHeader("Content-Disposition", `attachment; filename="${title}.${type === 'audio' ? 'mp3' : 'mp4'}"`);

    const tempDir = path.resolve(__dirname, "temp");
    fs.mkdirSync(tempDir, { recursive: true });

    // ============ AUDIO-ONLY ============
    if (type === "audio") {
      console.log("🎵 Starting audio-only stream...");
      const audioStream = ytdl(rawUrl, { filter: "audioonly", quality: "highestaudio" });
      res.setHeader("Content-Type", "audio/mpeg");
      return pipeline(audioStream, res, (err) => {
        if (err) console.error("❌ Audio stream error:", err);
      });
    }

    // ============ DIRECT VIDEO (with audio) ============
    if (format.hasVideo && format.hasAudio) {
      console.log("📼 Direct video+audio stream...");
      const stream = ytdl(rawUrl, { quality: itag });
      res.setHeader("Content-Type", "video/mp4");
      return pipeline(stream, res, (err) => {
        if (err) console.error("❌ Video stream error:", err);
      });
    }

    // ============ 1080p Merge (Separate Video + Audio) ============
    console.log("⚙️ Starting video+audio merge with ffmpeg...");

    const unique = Date.now() + "_" + Math.floor(Math.random() * 10000);
    const videoPath = path.join(tempDir, `${title}_${unique}_video.mp4`);
    const audioPath = path.join(tempDir, `${title}_${unique}_audio.mp3`);
    const outputPath = path.join(tempDir, `${title}_${unique}_merged.mp4`);

    try {
      await Promise.all([
        new Promise((res, rej) =>
          ytdl(rawUrl, { quality: itag })
            .pipe(fs.createWriteStream(videoPath))
            .on("finish", res)
            .on("error", rej)
        ),
        new Promise((res, rej) =>
          ytdl(rawUrl, { filter: "audioonly" })
            .pipe(fs.createWriteStream(audioPath))
            .on("finish", res)
            .on("error", rej)
        ),
      ]);
      console.log("✅ Video and audio downloaded successfully.");
    } catch (err) {
      console.error("❌ Download stream error:", err);
      return res.status(500).send("Failed to download video or audio stream.");
    }

    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .videoCodec("libx264")
      .audioCodec("aac")
      .outputOptions("-y")
      .save(outputPath)
      .on("end", () => {
        const stat = fs.statSync(outputPath);
        res.setHeader("Content-Length", stat.size);
        res.setHeader("Content-Type", "video/mp4");

        const readStream = fs.createReadStream(outputPath);
        pipeline(readStream, res, (err) => {
          [videoPath, audioPath, outputPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
          if (err) console.error("❌ Streaming merged video error:", err);
        });
      })
      .on("error", (err) => {
        console.error("❌ FFmpeg merge error:", err);
        [videoPath, audioPath, outputPath].forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
        res.status(500).send("Failed to merge video and audio.");
      });

  } catch (err) {
    console.error("❌ /download error:", err);
    res.status(500).send("Server error during download");
  }
});


app.listen(PORT, () => {
  console.log(`\u{1F680} Server running at http://localhost:${PORT}`);
});
