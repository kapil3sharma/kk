'use strict';
/**
 * Dhan HQ Live Order Execution & Management Module
 * 
 * Handles 1-Click order punching, bracket orders, position tracking,
 * and emergency square-off / exit.
 */

const DHAN_BASE_URL = 'https://api.dhan.co/v2';

function getHeaders(token, clientId) {
  const t = token || process.env.DHAN_ACCESS_TOKEN;
  const c = clientId || process.env.DHAN_CLIENT_ID;
  return {
    'access-token': t,
    'client-id': c,
    'dhanClientId': c,
    'Content-Type': 'application/json',
    'Accept': 'application/json'
  };
}

/**
 * Place a new live order with Dhan HQ
 * 
 * @param {Object} order
 *   - securityId {string} required: Dhan security ID (from option chain or scrip master)
 *   - transactionType {string}: 'BUY' | 'SELL' (default 'BUY')
 *   - quantity {number} required: Number of shares/units (e.g. 65 for 1 lot NIFTY)
 *   - orderType {string}: 'MARKET' | 'LIMIT' (default 'MARKET')
 *   - productType {string}: 'INTRADAY' | 'MARGIN' (default 'INTRADAY')
 *   - exchangeSegment {string}: 'NSE_FNO' | 'NSE_EQ' | 'BSE_FNO' (default 'NSE_FNO')
 *   - price {number}: required if orderType is LIMIT
 *   - triggerPrice {number}: optional for stop orders
 */
async function placeOrder(order, creds = {}) {
  const token = creds.accessToken || process.env.DHAN_ACCESS_TOKEN;
  const clientId = creds.clientId || process.env.DHAN_CLIENT_ID;

  if (!token || !clientId) {
    return { success: false, message: 'Dhan credentials not active or token expired.' };
  }

  if (!order.securityId) {
    return { success: false, message: 'Missing securityId for the order.' };
  }

  const qty = parseInt(order.quantity, 10);
  if (!qty || qty <= 0) {
    return { success: false, message: 'Invalid quantity: ' + order.quantity };
  }

  // Safety Cap: Don't allow massive fat-finger orders without explicit bypass
  const maxQtyCap = parseInt(process.env.MAX_ORDER_QTY || '650', 10); // default max 10 lots NIFTY
  if (qty > maxQtyCap && !order.bypassSafetyCap) {
    return {
      success: false,
      message: `Safety Block: Order quantity (${qty}) exceeds maximum allowed cap (${maxQtyCap}).`
    };
  }

  const correlationId = (order.correlationId || ('NIFTY_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6))).slice(0, 30);
  const orderType = (order.orderType || 'MARKET').toUpperCase();
  const transactionType = (order.transactionType || 'BUY').toUpperCase();
  const productType = (order.productType || 'INTRADAY').toUpperCase();
  const exchangeSegment = order.exchangeSegment || 'NSE_FNO';

  const payload = {
    dhanClientId: clientId,
    correlationId: correlationId,
    transactionType: transactionType,
    exchangeSegment: exchangeSegment,
    productType: productType,
    orderType: orderType,
    validity: 'DAY',
    securityId: String(order.securityId),
    quantity: qty,
    disclosedQuantity: 0,
    price: orderType === 'LIMIT' ? Number(order.price) : 0,
    triggerPrice: order.triggerPrice ? Number(order.triggerPrice) : 0,
    afterMarketOrder: false
  };

  try {
    console.log(`[Dhan Order] Placing ${transactionType} ${qty}x ${exchangeSegment} SecID: ${order.securityId} @ ${orderType}...`);
    const res = await fetch(`${DHAN_BASE_URL}/orders`, {
      method: 'POST',
      headers: getHeaders(token, clientId),
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    console.log('[Dhan Order Response]', JSON.stringify(data));

    if (data.orderId || data.orderStatus === 'TRANSIT' || data.orderStatus === 'PENDING' || data.status === 'success') {
      return {
        success: true,
        orderId: data.orderId,
        orderStatus: data.orderStatus || 'SUBMITTED',
        correlationId,
        message: `Order submitted! ID: ${data.orderId} (${data.orderStatus || 'PENDING'})`,
        data
      };
    } else {
      const errMsg = data.remarks || data.message || data.errorMessage || 'Order placement rejected by exchange/broker';
      return {
        success: false,
        orderStatus: data.orderStatus || 'REJECTED',
        message: errMsg,
        data
      };
    }
  } catch (err) {
    console.error('[Dhan Order Error]', err.message);
    return { success: false, message: err.message };
  }
}

/**
 * Fetch open and closed positions from Dhan
 */
async function getPositions(creds = {}) {
  const token = creds.accessToken || process.env.DHAN_ACCESS_TOKEN;
  const clientId = creds.clientId || process.env.DHAN_CLIENT_ID;
  if (!token || !clientId) return [];

  try {
    const res = await fetch(`${DHAN_BASE_URL}/positions`, {
      method: 'GET',
      headers: getHeaders(token, clientId)
    });
    if (res.status !== 200) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : (list.data || []);
  } catch (err) {
    console.warn('[Dhan GetPositions Error]', err.message);
    return [];
  }
}

/**
 * Fetch daily order book from Dhan
 */
async function getOrders(creds = {}) {
  const token = creds.accessToken || process.env.DHAN_ACCESS_TOKEN;
  const clientId = creds.clientId || process.env.DHAN_CLIENT_ID;
  if (!token || !clientId) return [];

  try {
    const res = await fetch(`${DHAN_BASE_URL}/orders`, {
      method: 'GET',
      headers: getHeaders(token, clientId)
    });
    if (res.status !== 200) return [];
    const list = await res.json();
    return Array.isArray(list) ? list : (list.data || []);
  } catch (err) {
    console.warn('[Dhan GetOrders Error]', err.message);
    return [];
  }
}

/**
 * Cancel an open order by Order ID
 */
async function cancelOrder(orderId, creds = {}) {
  const token = creds.accessToken || process.env.DHAN_ACCESS_TOKEN;
  const clientId = creds.clientId || process.env.DHAN_CLIENT_ID;
  if (!token || !clientId || !orderId) return { success: false, message: 'Missing parameters' };

  try {
    const res = await fetch(`${DHAN_BASE_URL}/orders/${orderId}`, {
      method: 'DELETE',
      headers: getHeaders(token, clientId)
    });
    const data = await res.json();
    return { success: res.status === 200, data };
  } catch (err) {
    return { success: false, message: err.message };
  }
}

/**
 * Fetch available cash, margin and collateral from Dhan
 */
async function getFundLimit(creds = {}) {
  const token = creds.accessToken || process.env.DHAN_ACCESS_TOKEN;
  const clientId = creds.clientId || process.env.DHAN_CLIENT_ID;
  if (!token || !clientId) return null;

  try {
    const res = await fetch(`${DHAN_BASE_URL}/fundlimit`, {
      method: 'GET',
      headers: getHeaders(token, clientId)
    });
    if (res.status !== 200) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

module.exports = {
  placeOrder,
  getPositions,
  getOrders,
  cancelOrder,
  getFundLimit
};
