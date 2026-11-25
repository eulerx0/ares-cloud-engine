'use strict';

const crypto = require('crypto');
const fs = require('fs');

const MAGIC = Buffer.from('ARESENC1', 'ascii'); // 8 bytes
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const HEADER_LEN = MAGIC.length + SALT_LEN + IV_LEN; // 36 bytes

function normalizeMasterKey(hexKey) {
    if (!hexKey || typeof hexKey !== 'string') return null;
    const clean = hexKey.trim();
    if (!/^[0-9a-fA-F]{64}$/.test(clean)) return null;
    return Buffer.from(clean, 'hex');
}

function deriveKey(masterKeyBuf, saltBuf) {
    return crypto.createHash('sha256').update(masterKeyBuf).update(saltBuf).digest();
}

function isEncryptedFile(filePath) {
    if (!filePath || !fs.existsSync(filePath)) return false;
    const stat = fs.statSync(filePath);
    if (stat.size < HEADER_LEN + TAG_LEN) return false;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(MAGIC.length);
        fs.readSync(fd, buf, 0, MAGIC.length, 0);
        return buf.equals(MAGIC);
    } finally {
        fs.closeSync(fd);
    }
}

async function encryptFile(srcPath, destPath, hexKey) {
    const masterKey = normalizeMasterKey(hexKey);
    if (!masterKey) throw new Error('Invalid AES-256 master key.');

    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const derivedKey = deriveKey(masterKey, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);

    await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(srcPath);
        const writeStream = fs.createWriteStream(destPath);
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { readStream.destroy(); } catch (_) {}
            try { writeStream.destroy(); } catch (_) {}
            reject(err);
        };

        writeStream.write(Buffer.concat([MAGIC, salt, iv]));
        readStream.on('error', fail);
        cipher.on('error', fail);
        writeStream.on('error', fail);

        readStream.on('data', (chunk) => {
            const enc = cipher.update(chunk);
            if (enc.length > 0 && !writeStream.write(enc)) {
                readStream.pause();
                writeStream.once('drain', () => readStream.resume());
            }
        });

        readStream.on('end', () => {
            try {
                const finalBlock = cipher.final();
                if (finalBlock.length > 0) writeStream.write(finalBlock);
                writeStream.write(cipher.getAuthTag());
                writeStream.end();
            } catch (err) {
                fail(err);
            }
        });

        writeStream.on('finish', () => {
            if (!settled) {
                settled = true;
                resolve(destPath);
            }
        });
    });

    return destPath;
}

async function decryptFile(srcPath, destPath, hexKey) {
    const masterKey = normalizeMasterKey(hexKey);
    if (!masterKey) throw new Error('Invalid AES-256 master key.');

    const stat = fs.statSync(srcPath);
    if (stat.size < HEADER_LEN + TAG_LEN) {
        throw new Error('Encrypted file is truncated or corrupted.');
    }

    const fd = fs.openSync(srcPath, 'r');
    let header;
    let authTag;
    try {
        header = Buffer.alloc(HEADER_LEN);
        fs.readSync(fd, header, 0, HEADER_LEN, 0);
        authTag = Buffer.alloc(TAG_LEN);
        fs.readSync(fd, authTag, 0, TAG_LEN, stat.size - TAG_LEN);
    } finally {
        fs.closeSync(fd);
    }

    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) {
        throw new Error('Invalid encrypted asset magic header.');
    }

    const salt = header.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = header.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
    const derivedKey = deriveKey(masterKey, salt);

    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(authTag);

    const cipherStart = HEADER_LEN;
    const cipherEndInclusive = stat.size - TAG_LEN - 1;

    if (cipherEndInclusive < cipherStart) {
        decipher.final();
        fs.writeFileSync(destPath, Buffer.alloc(0));
        return destPath;
    }

    await new Promise((resolve, reject) => {
        const readStream = fs.createReadStream(srcPath, { start: cipherStart, end: cipherEndInclusive });
        const writeStream = fs.createWriteStream(destPath);
        let settled = false;
        const fail = (err) => {
            if (settled) return;
            settled = true;
            try { readStream.destroy(); } catch (_) {}
            try { writeStream.destroy(); } catch (_) {}
            try { if (fs.existsSync(destPath)) fs.unlinkSync(destPath); } catch (_) {}
            reject(err);
        };

        readStream.on('error', fail);
        decipher.on('error', fail);
        writeStream.on('error', fail);

        readStream.on('data', (chunk) => {
            const dec = decipher.update(chunk);
            if (dec.length > 0 && !writeStream.write(dec)) {
                readStream.pause();
                writeStream.once('drain', () => readStream.resume());
            }
        });

        readStream.on('end', () => {
            try {
                const finalBlock = decipher.final();
                if (finalBlock.length > 0) writeStream.write(finalBlock);
                writeStream.end();
            } catch (err) {
                fail(new Error('GCM authentication failed (wrong key or tampered file).'));
            }
        });

        writeStream.on('finish', () => {
            if (!settled) {
                settled = true;
                resolve(destPath);
            }
        });
    });

    return destPath;
}

function encryptJson(obj, hexKey) {
    const masterKey = normalizeMasterKey(hexKey);
    if (!masterKey) return obj;
    const salt = crypto.randomBytes(SALT_LEN);
    const iv = crypto.randomBytes(IV_LEN);
    const derivedKey = deriveKey(masterKey, salt);
    const cipher = crypto.createCipheriv('aes-256-gcm', derivedKey, iv);
    const plaintext = Buffer.from(JSON.stringify(obj), 'utf8');
    const enc = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
        id: obj.id,
        encrypted: true,
        payload: Buffer.concat([MAGIC, salt, iv, enc, tag]).toString('base64')
    };
}

function decryptJson(envelope, hexKey) {
    if (!envelope || !envelope.encrypted || !envelope.payload) return envelope;
    const masterKey = normalizeMasterKey(hexKey);
    if (!masterKey) throw new Error('Cannot decrypt encrypted job payload without ARES_CRYPTO_KEY.');
    const raw = Buffer.from(envelope.payload, 'base64');
    if (raw.length < HEADER_LEN + TAG_LEN) throw new Error('Malformed encrypted JSON payload.');
    if (!raw.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Invalid encrypted JSON header.');
    const salt = raw.subarray(MAGIC.length, MAGIC.length + SALT_LEN);
    const iv = raw.subarray(MAGIC.length + SALT_LEN, HEADER_LEN);
    const tag = raw.subarray(raw.length - TAG_LEN);
    const ct = raw.subarray(HEADER_LEN, raw.length - TAG_LEN);
    const derivedKey = deriveKey(masterKey, salt);
    const decipher = crypto.createDecipheriv('aes-256-gcm', derivedKey, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
    return JSON.parse(plain.toString('utf8'));
}

module.exports = {
    normalizeMasterKey,
    isEncryptedFile,
    encryptFile,
    decryptFile,
    encryptJson,
    decryptJson
};
