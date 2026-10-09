// Key import. ~/.android/adbkey is PEM text; the credential store and rsaParsePrivateKey want DER
// bytes. Feeding the armor text in does not throw — it parses junk and every signature comes out
// as zero bytes, so authentication quietly degrades to the interactive "Allow USB debugging" path.
// Everything here validates by parsing, so a bad key fails at import instead.

export function toDer(lib, { text, bytes }) {
    let der;
    if (bytes) {
        der = bytes;
    } else if (/-----BEGIN/.test(text || "")) {
        const body = text.replace(/-----(BEGIN|END)[^-]*-----/g, "").replace(/\s+/g, "");
        if (body.length < 100) {
            throw new Error("that key has no base64 body — copy the whole file, including the BEGIN/END lines");
        }
        der = lib.decodeBase64(body);
    } else {
        throw new Error("paste the whole private key file, starting with -----BEGIN PRIVATE KEY-----");
    }
    const parsed = lib.rsaParsePrivateKey(der);
    if (!parsed || !parsed.n || !parsed.d) {
        throw new Error("that does not parse as an RSA private key");
    }
    return der;
}

export function importKey({ lib, store, name, text, bytes }) {
    const der = toDer(lib, { text, bytes });
    store.save(der, name || "imported");
    der.fill(0);
    return name || "imported";
}
