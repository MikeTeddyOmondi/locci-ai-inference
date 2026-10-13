/** A photo attached in the browser, sent to the model as a `file` part. */
export interface ImageAttachment {
	id: string;
	name: string;
	/** A data URL, so the message (and the saved thread) carries the image itself. */
	url: string;
	mediaType: string;
}

/** What the file picker offers. llama.cpp decodes PNG and JPEG; others are converted. */
export const IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

/** Longest side sent to the model. Gemma reads text in a 900 px invoice; more only costs time. */
const MAX_SIDE = 1280;
/** Small PNG and JPEG files under this go as they are, untouched. */
const KEEP_BYTES = 400_000;
const JPEG_QUALITY = 0.88;

function readAsDataURL(blob: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as string);
		reader.onerror = () => reject(reader.error ?? new Error('Could not read the image'));
		reader.readAsDataURL(blob);
	});
}

/**
 * Turn a picked, pasted or dropped image into something the model can read
 * and every request can carry: at most MAX_SIDE pixels on the long side, PNG
 * or JPEG. Every request resends the thread's photos, so a 4 MB phone photo
 * becomes a ~200 KB JPEG. Throws if the browser can't decode the file.
 */
export async function prepareImage(file: File): Promise<ImageAttachment> {
	const name = file.name || `Pasted image.${file.type === 'image/png' ? 'png' : 'jpg'}`;
	const bitmap = await createImageBitmap(file);
	try {
		const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
		const keep = scale === 1 && file.size <= KEEP_BYTES && (file.type === 'image/png' || file.type === 'image/jpeg');
		if (keep) return { id: crypto.randomUUID(), name, url: await readAsDataURL(file), mediaType: file.type };

		const canvas = document.createElement('canvas');
		canvas.width = Math.round(bitmap.width * scale);
		canvas.height = Math.round(bitmap.height * scale);
		const ctx = canvas.getContext('2d');
		if (!ctx) throw new Error('Could not process the image');
		// JPEG has no transparency: put see-through areas on white, not black.
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, canvas.width, canvas.height);
		ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
		if (!blob) throw new Error('Could not process the image');
		return { id: crypto.randomUUID(), name, url: await readAsDataURL(blob), mediaType: 'image/jpeg' };
	} finally {
		bitmap.close();
	}
}
