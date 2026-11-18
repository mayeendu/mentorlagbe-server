import express, { type RequestHandler } from "express";

const imageTypes = ["image/jpeg", "image/png", "image/webp"];
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function isHostedImage(value: string) {
  try {
    const url = new URL(value);
    return url.origin === "https://i.ibb.co" && !url.username && !url.password && url.pathname.length > 1;
  } catch {
    return false;
  }
}

export const readImage = express.raw({ type: imageTypes, limit: "5mb", inflate: false });

export const uploadTuitionImage: RequestHandler = async (req, res) => {
  const file: unknown = req.body;
  const mime = req.get("content-type")?.split(";")[0].trim().toLowerCase();
  const valid = Buffer.isBuffer(file) && (
    (mime === "image/jpeg" && file.subarray(0, 3).equals(Buffer.from([255, 216, 255]))) ||
    (mime === "image/png" && file.subarray(0, 8).equals(pngSignature)) ||
    (mime === "image/webp" && file.toString("ascii", 0, 4) === "RIFF" && file.toString("ascii", 8, 12) === "WEBP")
  );
  if (!valid) {
    res.status(415).json({ error: "Select a JPEG, PNG, or WebP image." });
    return;
  }

  const key = process.env.IMGBB_API_KEY;
  if (!key) {
    res.status(503).json({ error: "Image uploads are unavailable." });
    return;
  }

  const endpoint = new URL("https://api.imgbb.com/1/upload");
  endpoint.searchParams.set("key", key);
  const body = new FormData();
  body.set("image", new Blob([new Uint8Array(file)], { type: mime }), "tuition." + mime?.slice(6));
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      body,
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Upload rejected");
    const result = await response.json();
    const url: unknown = result?.data?.url;
    if (result?.success !== true || typeof url !== "string" || !isHostedImage(url)) {
      throw new Error("Invalid upload response");
    }
    res.status(201).json({ imageUrl: url });
  } catch {
    res.status(502).json({ error: "Could not upload the image. Try again." });
  }
};
