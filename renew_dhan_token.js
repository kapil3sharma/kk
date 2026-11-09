#!/usr/bin/env node
/**
 * Dhan Token Renewal & Management Utility
 * 
 * Usage:
 *   node renew_dhan_token.js               -> Check token status & auto-renew if valid
 *   node renew_dhan_token.js <NEW_TOKEN>   -> Save and verify a freshly generated token from Dhan portal
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config();
const DHAN_AUTH = require('./dhan_auth');

const ENV_PATH = path.join(__dirname, '.env');

function parseJwt(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch (e) {
    return null;
  }
}

function updateEnvToken(newToken, clientId) {
  let content = fs.existsSync(ENV_PATH) ? fs.readFileSync(ENV_PATH, 'utf8') : '';
  
  if (content.includes('DHAN_ACCESS_TOKEN=')) {
    content = content.replace(/DHAN_ACCESS_TOKEN=.*/, `DHAN_ACCESS_TOKEN=${newToken}`);
  } else {
    content += `\nDHAN_ACCESS_TOKEN=${newToken}\n`;
  }

  if (clientId) {
    if (content.includes('DHAN_CLIENT_ID=')) {
      content = content.replace(/DHAN_CLIENT_ID=.*/, `DHAN_CLIENT_ID=${clientId}`);
    } else {
      content += `DHAN_CLIENT_ID=${clientId}\n`;
    }
  }

  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

async function verifyTokenWithDhan(token, clientId) {
  try {
    const res = await fetch('https://api.dhan.co/v2/fundlimit', {
      method: 'GET',
      headers: {
        'access-token': token,
        'client-id': clientId
      }
    });
    if (res.status === 200) {
      return { ok: true, data: await res.json() };
    }
    const errBody = await res.text();
    return { ok: false, status: res.status, error: errBody };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function tryRenewToken(token, clientId) {
  try {
    const res = await fetch('https://api.dhan.co/v2/RenewToken', {
      method: 'GET',
      headers: {
        'access-token': token,
        'dhanClientId': clientId,
        'client-id': clientId
      }
    });
    const data = await res.json();
    return { status: res.status, data };
  } catch (err) {
    return { status: 500, error: err.message };
  }
}

async function main() {
  console.log('====================================================');
  console.log('         🔑 Dhan HQ Token Status & Renewal          ');
  console.log('====================================================\n');

  const argToken = process.argv[2] ? process.argv[2].trim() : null;

  // Case 1: Auto-login flag
  if (argToken === '--auto') {
    console.log('⚡ Running Automated Zero-Touch Login using TOTP...');
    const res = await DHAN_AUTH.autoLoginDhan();
    if (res.success) {
      console.log('🎉 SUCCESS! New token generated & saved to .env.');
      process.exit(0);
    } else {
      console.error('❌ Auto-Login Failed:', res.message);
      process.exit(1);
    }
  }

  // Case 2: User passed a new token from Dhan portal as argument
  if (argToken) {
    console.log('📥 Verifying new token provided as argument...');
    const payload = parseJwt(argToken);
    if (!payload || !payload.exp) {
      console.error('❌ Error: The provided token does not look like a valid JWT token.');
      process.exit(1);
    }

    const clientId = payload.dhanClientId || process.env.DHAN_CLIENT_ID;
    const expDate = new Date(payload.exp * 1000);
    const now = new Date();

    if (now >= expDate) {
      console.error(`❌ Error: Provided token is already expired (Expired at: ${expDate.toLocaleString('en-IN')})`);
      process.exit(1);
    }

    console.log(`✅ Token decoded:`);
    console.log(`   Client ID : ${clientId}`);
    console.log(`   Issued At : ${new Date(payload.iat * 1000).toLocaleString('en-IN')}`);
    console.log(`   Valid Till: ${expDate.toLocaleString('en-IN')}`);

    console.log('\n📡 Testing connection with Dhan HQ API...');
    const verify = await verifyTokenWithDhan(argToken, clientId);
    if (verify.ok) {
      updateEnvToken(argToken, clientId);
      console.log('🎉 SUCCESS! New Dhan Token verified and saved to .env file.');
      console.log('🚀 You can now start or restart your server (npm start).\n');
      process.exit(0);
    } else {
      console.warn('⚠️ Warning: Dhan API rejected this token:');
      console.warn(`   Status: ${verify.status || 'unknown'}`);
      console.warn(`   Details: ${verify.error}`);
      console.log('\nSaving to .env anyway...');
      updateEnvToken(argToken, clientId);
      console.log('💾 Saved to .env.\n');
      process.exit(1);
    }
  }

  // Case 3: Check current token in .env
  const currentToken = process.env.DHAN_ACCESS_TOKEN || '';
  const currentClientId = process.env.DHAN_CLIENT_ID || '';

  if (!currentToken) {
    console.log('❌ No DHAN_ACCESS_TOKEN found in .env\n');
    if (process.env.DHAN_PIN && process.env.DHAN_TOTP_SECRET) {
      console.log('💡 Found DHAN_PIN and DHAN_TOTP_SECRET! Running auto-login...');
      const al = await DHAN_AUTH.autoLoginDhan();
      if (al.success) {
        console.log('🎉 SUCCESS! Token generated and saved to .env.\n');
        process.exit(0);
      }
    }
    printHowToGetToken();
    process.exit(1);
  }

  const payload = parseJwt(currentToken);
  if (!payload || !payload.exp) {
    console.log('⚠️ Current DHAN_ACCESS_TOKEN could not be parsed as a JWT.\n');
    printHowToGetToken();
    process.exit(1);
  }

  const clientId = payload.dhanClientId || currentClientId;
  const expDate = new Date(payload.exp * 1000);
  const iatDate = payload.iat ? new Date(payload.iat * 1000) : null;
  const now = new Date();
  const diffHours = (expDate - now) / (1000 * 60 * 60);

  console.log(`📋 Current Token Info:`);
  console.log(`   Client ID   : ${clientId}`);
  if (iatDate) console.log(`   Generated At: ${iatDate.toLocaleString('en-IN')}`);
  console.log(`   Expires At  : ${expDate.toLocaleString('en-IN')}`);

  if (diffHours <= 0) {
    console.log(`\n❌ STATUS: TOKEN IS EXPIRED!`);
    console.log(`   Expired ${(Math.abs(diffHours)).toFixed(1)} hours ago.`);

    if (process.env.DHAN_PIN && process.env.DHAN_TOTP_SECRET) {
      console.log(`\n⚡ Detected DHAN_PIN and DHAN_TOTP_SECRET in .env!`);
      console.log(`   Triggering automated Zero-Touch Login via TOTP...`);
      const al = await DHAN_AUTH.autoLoginDhan({ clientId, pin: process.env.DHAN_PIN, totpSecret: process.env.DHAN_TOTP_SECRET });
      if (al.success) {
        console.log(`\n🎉 AUTO-LOGIN SUCCESSFUL! New token active and saved to .env.`);
        process.exit(0);
      } else {
        console.warn(`⚠️ Auto-Login attempt failed: ${al.message}`);
      }
    }

    console.log(`\n⚠️ NOTE: Dhan HQ does NOT allow programmatic renewal of ALREADY EXPIRED tokens via /v2/RenewToken.`);
    console.log(`   You can either configure DHAN_PIN & DHAN_TOTP_SECRET for Zero-Touch Auto-Login,`);
    console.log(`   or generate a new token from web.dhan.co:\n`);
    printHowToGetToken();
    process.exit(1);
  } else {
    console.log(`\n🟢 STATUS: ACTIVE (~${diffHours.toFixed(1)} hours remaining)`);
    console.log('🔄 Attempting to renew token via Dhan /v2/RenewToken endpoint...');
    
    const renew = await tryRenewToken(currentToken, clientId);
    if (renew.data && (renew.data.token || renew.data.accessToken)) {
      const newToken = renew.data.token || renew.data.accessToken;
      updateEnvToken(newToken, clientId);
      const newPayload = parseJwt(newToken);
      const newExp = newPayload ? new Date(newPayload.exp * 1000).toLocaleString('en-IN') : renew.data.expiryTime || '+24h';
      console.log(`\n🎉 TOKEN RENEWED SUCCESSFULLY!`);
      console.log(`   New Expiry: ${newExp}`);
      console.log(`   Updated .env automatically.\n`);
    } else {
      console.log(`\n⚠️ Renewal attempt returned:`, renew.data || renew.error);
    }
  }
}

function printHowToGetToken() {
  console.log('----------------------------------------------------');
  console.log('👉 HOW TO GENERATE A NEW DHAN ACCESS TOKEN:');
  console.log('----------------------------------------------------');
  console.log('1. Go to: https://web.dhan.co');
  console.log('2. Log in with your Dhan mobile & PIN/OTP.');
  console.log('3. Click on your Profile (top right avatar) -> "DhanHQ Trading APIs" or "Access Token".');
  console.log('4. Click "Generate Access Token" (Select 30 Days validity).');
  console.log('5. Copy the generated token string.');
  console.log('6. Run either:');
  console.log('     node renew_dhan_token.js <PASTE_YOUR_TOKEN_HERE>');
  console.log('   OR');
  console.log('     Paste it into .env under DHAN_ACCESS_TOKEN=...');
  console.log('----------------------------------------------------\n');
}

main();
