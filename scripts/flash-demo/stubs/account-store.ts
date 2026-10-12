// demo stub of src/lib/account-store.ts: one made-up futures account
const accounts = [{ account_type: 'F' as const, broker_id: 'F002000', account_id: '9804567', person_id: '', signed: true, username: '示範帳戶' }];
const state = { loaded: true, accounts, selectedStock: undefined, selectedFutures: accounts[0] };
export function ensureAccounts() { return undefined; }
export function refreshAccounts() { return Promise.resolve(); }
export function selectAccount() { /* demo */ }
export function getAccountState() { return state; }
export function accountFor(t: 'S' | 'F') { return t === 'F' ? accounts[0] : undefined; }
export function subscribeAccounts() { return () => undefined; }
export function useAccounts() { return state; }
