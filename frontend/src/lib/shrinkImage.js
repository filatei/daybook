/**
 * Shrink a photo in the browser before uploading.
 *
 * Phone/WhatsApp photos are typically 2–5 MB. Base64-encoding for a vision model
 * adds ~33% on top, so a raw upload ships ~4–7 MB to the AI provider — slow enough
 * to blow past the extraction timeout, and billed as far more image tokens than
 * the text actually needs. A printed receipt is perfectly legible at ~1400px on
 * the long edge, which usually lands around 150–300 KB.
 *
 * Fails soft: if anything goes wrong (unsupported type, canvas blocked, HEIC the
 * browser can't decode) the ORIGINAL file is returned, so upload never breaks.
 */

const DEFAULTS = { maxEdge: 1400, quality: 0.8, skipUnder: 300 * 1024 };

export async function shrinkImage(file, opts = {}) {
  const { maxEdge, quality, skipUnder } = { ...DEFAULTS, ...opts };
  try {
    if (!file || !file.type || !file.type.startsWith('image/')) return file;   // PDFs etc. pass through
    if (file.size <= skipUnder) return file;                                    // already small enough

    const bitmap = await loadBitmap(file);
    if (!bitmap) return file;

    const { width, height } = bitmap;
    const longest = Math.max(width, height);
    // Never upscale — a small photo stays as it is.
    const scale = longest > maxEdge ? maxEdge / longest : 1;
    if (scale === 1 && file.size <= skipUnder) return file;

    const w = Math.max(1, Math.round(width * scale));
    const h = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // White backdrop: JPEG has no alpha, and transparent PNGs would go black.
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    if (bitmap.close) bitmap.close();

    const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
    if (!blob || blob.size >= file.size) return file;   // no gain — keep the original

    const name = (file.name || 'slip').replace(/\.[^.]+$/, '') + '.jpg';
    return new File([blob], name, { type: 'image/jpeg', lastModified: Date.now() });
  } catch {
    return file;   // never block the upload on a resize failure
  }
}

// createImageBitmap handles EXIF orientation on modern browsers; fall back to an
// <img> for older ones.
async function loadBitmap(file) {
  if (typeof createImageBitmap === 'function') {
    try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { /* fall through */ }
  }
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

export const kb = (n) => `${Math.max(1, Math.round((n || 0) / 1024))} KB`;
