/**
 * useBTPrinter — Web Bluetooth ESC/POS hook
 *
 * Supports Xprinter XP-58/XP-80 and Epson TM series via BLE.
 * Tries multiple known BLE GATT profiles (different printer chipsets).
 */
import { useState, useRef, useCallback, useEffect } from 'react';

// BLE service → write-characteristic pairs, ordered by market share
const PROFILES = [
  { service: '000018f0-0000-1000-8000-00805f9b34fb', write: '00002af1-0000-1000-8000-00805f9b34fb' }, // Cashino / Xprinter BLE
  { service: '49535343-fe7d-4ae5-8fa9-9fafd205e455', write: '49535343-8841-43f4-a8d4-ecbe34729bb3' }, // Microchip BM70/71
  { service: 'e7810a71-73ae-499d-8c15-faa9aef0c3f2', write: 'bef8d6c9-9c21-4c9e-b632-bd58c1009f9f' }, // Epson TM BLE
  { service: '0000ff00-0000-1000-8000-00805f9b34fb', write: '0000ff02-0000-1000-8000-00805f9b34fb' }, // Generic BLE serial
];

// ── ESC/POS byte constants ────────────────────────────────────────────────────
const ESC = 0x1b;
const GS  = 0x1d;
const LF  = 0x0a;
const ENC = new TextEncoder();

const CMD_INIT       = new Uint8Array([ESC, 0x40]);         // Initialize printer
const CMD_CENTER     = new Uint8Array([ESC, 0x61, 0x01]);   // Center justify
const CMD_LEFT       = new Uint8Array([ESC, 0x61, 0x00]);   // Left justify
const CMD_BOLD_ON    = new Uint8Array([ESC, 0x45, 0x01]);   // Bold on
const CMD_BOLD_OFF   = new Uint8Array([ESC, 0x45, 0x00]);   // Bold off
const CMD_SIZE_BIG   = new Uint8Array([GS,  0x21, 0x11]);   // Double width+height
const CMD_SIZE_NORM  = new Uint8Array([GS,  0x21, 0x00]);   // Normal size
const CMD_CUT        = new Uint8Array([GS,  0x56, 0x42, 0x00]); // Partial cut
const DIVIDER        = ENC.encode('--------------------------------\n');
const NEWLINES       = new Uint8Array([LF, LF, LF]);

/**
 * Build ESC/POS Code 128 barcode command for a receipt number string.
 * Uses Code Set B (ASCII), GS k 0x49 n [data] (new-style length prefix).
 * Barcode height: 64 dots; HRI (human-readable) below; module width: 2.
 */
function barcodeCode128(numStr) {
  // Subset B prefix: 0x7B, 0x42 = "{B"
  const payload = new Uint8Array([0x7B, 0x42, ...Array.from(numStr).map((c) => c.charCodeAt(0))]);
  return new Uint8Array([
    GS, 0x68, 64,        // GS h — barcode height 64 dots
    GS, 0x48, 0x02,      // GS H — HRI below barcode
    GS, 0x77, 0x02,      // GS w — module width 2
    GS, 0x6B, 0x49,      // GS k 73 — Code 128 (new format)
    payload.length,      // n bytes
    ...payload,
  ]);
}

const t = (s) => ENC.encode(s);

// Pad/truncate to fixed column width
const rpad = (s, n) => String(s).slice(0, n).padEnd(n, ' ');
const lpad = (s, n) => String(s).slice(0, n).padStart(n, ' ');

// Two-column row at given total width
function twoCol(left, right, width = 32) {
  const r = String(right);
  const l = String(left).slice(0, width - r.length);
  return l.padEnd(width - r.length, ' ') + r + '\n';
}

// Format Naira without ₦ unicode (printer ASCII fallback: N)
const N = (v) => 'N' + Number(v || 0).toLocaleString('en-NG');

/**
 * Build ESC/POS receipt bytes.
 *
 * @param {Object} opts
 * @param {string} opts.company       - Business/tenant name
 * @param {string} [opts.site_name]   - Site/branch name
 * @param {number} opts.receipt_no    - Receipt number
 * @param {string} opts.date_str      - e.g. "14 Jun 2026"
 * @param {string} opts.time_str      - e.g. "10:30 AM"
 * @param {Array}  opts.items         - [{ name, qty, price, amount }]
 * @param {number} opts.total         - Grand total
 * @param {string} opts.payment_method - CASH | TRANSFER | POS
 * @param {number} [opts.amount_paid]
 * @param {number} [opts.change]
 * @param {string} [opts.customer_name]
 */
export function buildReceipt(opts) {
  const {
    company = 'FIDO WATER',
    site_name,
    receipt_no,
    date_str = '',
    time_str = '',
    items = [],
    total = 0,
    payment_method = 'CASH',
    amount_paid = 0,
    change = 0,
    customer_name,
    served_by,
    bank,
    terminal,
  } = opts;

  const chunks = [];
  const push = (...parts) => parts.forEach((p) => { if (p && p.length) chunks.push(p); });

  // Header
  push(CMD_INIT, CMD_CENTER, CMD_SIZE_BIG, t(company + '\n'), CMD_SIZE_NORM);
  if (site_name) push(t(site_name + '\n'));
  push(CMD_LEFT, DIVIDER);

  // Receipt meta
  const rno = String(receipt_no || '').padStart(4, '0');
  push(t(`Receipt: #${rno}\n`));
  push(t(`Date:    ${date_str}\n`));
  push(t(`Time:    ${time_str}\n`));
  if (customer_name) push(t(`Customer: ${customer_name}\n`));
  if (served_by) push(t(`Served by: ${served_by}\n`));
  push(DIVIDER);

  // Items
  for (const it of items) {
    push(CMD_BOLD_ON, t(it.name + '\n'), CMD_BOLD_OFF);
    push(t(twoCol(`  ${it.qty} x ${N(it.price)}`, N(it.amount))));
  }

  // Totals
  push(DIVIDER);
  push(CMD_BOLD_ON, t(twoCol('TOTAL', N(total))), CMD_BOLD_OFF);
  push(t(`Payment: ${payment_method}\n`));
  if (terminal) push(t(`Terminal: ${terminal}\n`));
  if (bank) push(t(`Bank: ${bank}\n`));
  if (payment_method === 'CASH' && amount_paid > 0) {
    push(t(twoCol('Tendered', N(amount_paid))));
    push(t(twoCol('Change', N(change))));
  }

  // Footer: instruction + Code 128 barcode for scanner stations
  push(DIVIDER, CMD_CENTER, CMD_BOLD_ON);
  push(t('TAKE TO LOADING POINT\n'));
  push(CMD_BOLD_OFF, CMD_SIZE_NORM);
  push(t(`Receipt #${rno}\n`));
  push(new Uint8Array([LF]));
  push(barcodeCode128(String(receipt_no || '')));
  push(DIVIDER, NEWLINES, CMD_CUT);

  // Combine into a single Uint8Array
  const total_len = chunks.reduce((a, c) => a + c.length, 0);
  const buf = new Uint8Array(total_len);
  let off = 0;
  for (const c of chunks) { buf.set(c, off); off += c.length; }
  return buf;
}

// Write data in MTU-safe chunks with small inter-chunk delay
async function writeInChunks(char, data, chunkSize = 200) {
  for (let i = 0; i < data.length; i += chunkSize) {
    await char.writeValue(data.slice(i, i + chunkSize));
    // Small delay prevents buffer overflow on cheap BLE chips
    await new Promise((r) => setTimeout(r, 30));
  }
}

// ── Hook ─────────────────────────────────────────────────────────────────────

const LAST_DEVICE_KEY = 'bt_last_device';

export function useBTPrinter() {
  const [status, setStatus] = useState('idle'); // idle | connecting | ready | printing | error
  const [error, setError] = useState(null);
  const charRef     = useRef(null);
  const deviceRef   = useRef(null);
  const intentional = useRef(false);  // true when the user disconnected on purpose
  const reconnTimer = useRef(null);

  // Bind the write characteristic from a connected GATT server.
  const bindChar = useCallback(async (server) => {
    let writeChar = null;
    for (const prof of PROFILES) {
      try {
        const svc = await server.getPrimaryService(prof.service);
        writeChar = await svc.getCharacteristic(prof.write);
        break;
      } catch { /* try next profile */ }
    }
    if (!writeChar) throw new Error('No compatible print service found on this device. Check that the printer is in BLE mode.');
    charRef.current = writeChar;
    setStatus('ready');
    setError(null);
  }, []);

  // Reconnect to the already-chosen device (no user gesture needed) with backoff.
  const reconnect = useCallback(async (attempts = 6, { silent = false } = {}) => {
    const device = deviceRef.current;
    if (!device || !device.gatt) return false;
    for (let i = 0; i < attempts; i++) {
      if (charRef.current && device.gatt.connected) return true;
      try {
        setStatus('connecting');
        const server = await device.gatt.connect();
        await bindChar(server);
        return true;
      } catch {
        await new Promise((r) => setTimeout(r, Math.min(400 * 2 ** i, 4000)));
      }
    }
    if (silent) { setStatus('idle'); } else { setStatus('error'); setError('Lost connection to the printer — tap to retry.'); }
    return false;
  }, [bindChar]);

  // Attach the device + a one-time auto-reconnect-on-drop handler.
  const trackDevice = useCallback((device) => {
    deviceRef.current = device;
    try { if (device.id) localStorage.setItem(LAST_DEVICE_KEY, device.id); } catch { /* ignore */ }
    if (device.__daybookTracked) return;
    device.__daybookTracked = true;
    device.addEventListener('gattserverdisconnected', () => {
      charRef.current = null;
      if (intentional.current) { setStatus('idle'); return; }
      // Auto-reconnect (e.g. printer slept, went briefly out of range).
      clearTimeout(reconnTimer.current);
      reconnTimer.current = setTimeout(() => { reconnect(8).catch(() => {}); }, 600);
    });
  }, [reconnect]);

  const connect = useCallback(async () => {
    if (!navigator.bluetooth) throw new Error('Web Bluetooth is not supported in this browser. Use Chrome on Android or desktop.');
    setStatus('connecting');
    setError(null);
    intentional.current = false;
    try {
      const device = await navigator.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: PROFILES.map((p) => p.service),
      });
      trackDevice(device);
      const server = await device.gatt.connect();
      await bindChar(server);
    } catch (e) {
      setError(e.message || String(e));
      setStatus('error');
      throw e;
    }
  }, [bindChar, trackDevice]);

  const print = useCallback(async (receiptData) => {
    // Not connected? Try to bring a known printer back before giving up.
    if (!charRef.current || !deviceRef.current?.gatt?.connected) {
      const ok = await reconnect(4);
      if (!ok || !charRef.current) throw new Error('Printer not connected');
    }
    setStatus('printing');
    const bytes = buildReceipt(receiptData);
    try {
      await writeInChunks(charRef.current, bytes);
      setStatus('ready');
    } catch (e) {
      // Mid-print drop: reconnect once and resend so the sale never loses its receipt.
      charRef.current = null;
      const ok = await reconnect(4);
      if (ok && charRef.current) {
        setStatus('printing');
        await writeInChunks(charRef.current, bytes);
        setStatus('ready');
      } else {
        setError(e.message || String(e));
        setStatus('error');
        throw e;
      }
    }
  }, [reconnect]);

  const disconnect = useCallback(() => {
    intentional.current = true;
    clearTimeout(reconnTimer.current);
    try { deviceRef.current?.gatt?.disconnect(); } catch { /* ignore */ }
    charRef.current = null;
    deviceRef.current = null;
    try { localStorage.removeItem(LAST_DEVICE_KEY); } catch { /* ignore */ }
    setStatus('idle');
    setError(null);
  }, []);

  // On mount: silently restore a previously-granted printer (persists the pairing
  // across reloads) and reconnect in the background, so it's ready without re-pairing.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!navigator.bluetooth?.getDevices) return;
      try {
        const devs = await navigator.bluetooth.getDevices();
        if (cancelled || !devs.length) return;
        let lastId = null; try { lastId = localStorage.getItem(LAST_DEVICE_KEY); } catch { /* ignore */ }
        const dev = devs.find((d) => d.id === lastId) || devs[0];
        if (!dev) return;
        trackDevice(dev);
        reconnect(3, { silent: true }).catch(() => {});
      } catch { /* getDevices unsupported / denied */ }
    })();
    return () => { cancelled = true; clearTimeout(reconnTimer.current); };
  }, [reconnect, trackDevice]);

  return { status, error, connect, print, disconnect };
}
