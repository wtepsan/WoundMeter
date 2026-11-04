const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
export const MIN_IMAGE_DIMENSION = 480;

export async function validateImage(file: File): Promise<void> {
  if (!ALLOWED_TYPES.has(file.type)) {
    const message = file.type.includes("heic") || file.type.includes("heif")
      ? "HEIC/HEIF is not supported. Export the photograph as JPEG first."
      : "Choose a JPEG, PNG, or WebP image.";
    throw new Error(message);
  }
  if (file.size === 0) throw new Error("The selected file is empty.");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("The selected image exceeds 10 MB.");

  let bitmap: ImageBitmap | null = null;
  try {
    bitmap = await createImageBitmap(file);
    if (Math.min(bitmap.width, bitmap.height) < MIN_IMAGE_DIMENSION) {
      throw new Error(`Use an image at least ${MIN_IMAGE_DIMENSION} px on its shortest side.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Use an image")) throw error;
    throw new Error("The selected image could not be decoded.");
  } finally {
    bitmap?.close();
  }
}
