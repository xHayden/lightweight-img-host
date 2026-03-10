import { getContentType, MIME_MAP } from "../mime";

describe("getContentType", () => {
    test("returns correct types for images", () => {
        expect(getContentType("photo.jpg")).toBe("image/jpeg");
        expect(getContentType("photo.jpeg")).toBe("image/jpeg");
        expect(getContentType("image.png")).toBe("image/png");
        expect(getContentType("anim.gif")).toBe("image/gif");
        expect(getContentType("pic.webp")).toBe("image/webp");
    });

    test("returns correct types for documents", () => {
        expect(getContentType("doc.pdf")).toBe("application/pdf");
        expect(getContentType("archive.zip")).toBe("application/zip");
        expect(getContentType("notes.txt")).toBe("text/plain");
        expect(getContentType("data.json")).toBe("application/json");
        expect(getContentType("data.csv")).toBe("text/csv");
    });

    test("falls back to octet-stream for unknown types", () => {
        expect(getContentType("file.xyz")).toBe("application/octet-stream");
        expect(getContentType("data.bin")).toBe("application/octet-stream");
    });

    test("handles uppercase extensions", () => {
        expect(getContentType("PHOTO.JPG")).toBe("image/jpeg");
        expect(getContentType("IMAGE.PNG")).toBe("image/png");
    });
});
