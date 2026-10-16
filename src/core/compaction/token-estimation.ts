/** Approximate ASCII at four chars/token and non-ASCII at 1.5 UTF-16 units/token. */
export function estimateStringTokens(text: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) < 0x80) ascii++;
		else nonAscii++;
	}
	return Math.ceil(ascii / 4 + nonAscii / 1.5);
}
