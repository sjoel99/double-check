/** Imagem do QR. A biblioteca só é baixada quando um QR aparece (não entra no chunk principal). */
export async function qrDataUrl(text: string): Promise<string> {
  const { default: QRCode } = await import("qrcode");
  return QRCode.toDataURL(text, { margin: 1, width: 480, errorCorrectionLevel: "M" });
}
