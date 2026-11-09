'use strict';
/**
 * Dhan HQ Automated TOTP Login & Token Generator
 * 
 * Generates an active 24-hour Dhan Access Token programmatically using
 * Client ID, Trading PIN, and TOTP Secret (Base32 key).
 * 
 * Works 100% in Node.js using native crypto (zero external npm dependencies required).
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');

/**
 * Decode Base32 string to Buffer (RFC 4648)
 */
function base32Decode(base32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0, output = [];
  const clean = String(base32 || '').replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  for (let i = 0; i < clean.length; i++) {
    const idx = alphabet.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(output);
}

/**
 * Generate 6-digit TOTP code (RFC 6238)
 */
function generateTOTP(secret, epochSeconds = null) {
  if (!secret) throw new Error('TOTP Secret is required');
  const key = base32Decode(secret);
  const epoch = epochSeconds != null ? epochSeconds : Math.floor(Date.now() / 1000);
  const timeStep = Math.floor(epoch / 30);
  
  const timeBuffer = Buffer.alloc(8);
  timeBuffer.writeBigUInt64BE(BigInt(timeStep));
  
  const hmac = crypto.createHmac('sha1', key).update(timeBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (((hmac[offset] & 0x7f) << 24) |
                ((hmac[offset + 1] & 0xff) << 16) |
                ((hmac[offset + 2] & 0xff) << 8) |
                (hmac[offset + 3] & 0xff)) % 1000000;
  
  return String(code).padStart(6, '0');
}

/**
 * Save new Dhan token and credentials into .env
 */
function updateEnv(updates = {}) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  for (const [k, v] of Object.entries(updates)) {
    if (v == null) continue;
    const regex = new RegExp(`^${k}=.*$`, 'm');
    if (regex.test(content)) {
      content = content.replace(regex, `${k}=${v}`);
    } else {
      content += `\n${k}=${v}`;
    }
  }
  fs.writeFileSync(ENV_PATH, content.trim() + '\n', 'utf8');
}

/**
 * Perform automated login to Dhan HQ using Client ID, PIN & TOTP Secret
 */
async function autoLoginDhan(opts = {}) {
  const clientId = (opts.clientId || process.env.DHAN_CLIENT_ID || '').trim();
  const pin = (opts.pin || process.env.DHAN_PIN || '').trim();
  const totpSecret = (opts.totpSecret || process.env.DHAN_TOTP_SECRET || '').trim();

  if (!clientId) {
    return { success: false, message: 'DHAN_CLIENT_ID missing in .env or settings' };
  }
  if (!pin) {
    return { success: false, message: 'DHAN_PIN missing (Enter your 4 or 6-digit Dhan trading PIN)' };
  }
  if (!totpSecret) {
    return { success: false, message: 'DHAN_TOTP_SECRET missing (Enable TOTP on web.dhan.co and copy the secret key)' };
  }

  try {
    const totpCode = generateTOTP(totpSecret);
    console.log(`[Dhan Auto-Login] Generating Access Token for Client: ${clientId} with TOTP: ${totpCode}...`);

    const url = 'https://auth.dhan.co/app/generateAccessToken';
    const params = new URLSearchParams({
      dhanClientId: clientId,
      pin: pin,
      totp: totpCode
    });

    const res = await fetch(`${url}?${params.toString()}`, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
      }
    });

    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return { success: false, status: res.status, message: `Dhan Auth response not JSON: ${text.slice(0, 150)}` };
    }

    const token = data.accessToken || data.token || data.data?.accessToken;
    if (token) {
      console.log(`[Dhan Auto-Login] ✅ Access Token generated successfully!`);
      // Update .env
      updateEnv({
        DHAN_CLIENT_ID: clientId,
        DHAN_ACCESS_TOKEN: token,
        DHAN_PIN: pin,
        DHAN_TOTP_SECRET: totpSecret
      });
      process.env.DHAN_ACCESS_TOKEN = token;
      process.env.DHAN_CLIENT_ID = clientId;

      return {
        success: true,
        token: token,
        expiryTime: data.expiryTime,
        message: 'Dhan Auto-Login successful! Token saved.'
      };
    } else {
      const errMsg = data.errorMessage || data.message || data.remarks || JSON.stringify(data);
      console.warn(`[Dhan Auto-Login] ❌ Failed: ${errMsg}`);
      return { success: false, status: res.status, message: errMsg };
    }
  } catch (err) {
    console.error(`[Dhan Auto-Login Error]`, err.message);
    return { success: false, message: err.message };
  }
}

module.exports = {
  generateTOTP,
  autoLoginDhan,
  updateEnv
};

if (require.main === module) {
  require('dotenv').config();
  autoLoginDhan().then(r => {
    console.log('\nResult:', r);
    process.exit(r.success ? 0 : 1);
  });
}
