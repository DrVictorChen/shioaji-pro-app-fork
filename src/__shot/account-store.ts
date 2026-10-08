const accounts = [
    { account_type: 'S', broker_id: '9A95', account_id: '0012345', signed: true, person_id: '', username: 'demo' },
    { account_type: 'F', broker_id: 'F002000', account_id: '1234567', signed: true, person_id: '', username: 'demo' },
];
const state = { loaded: true, accounts, selectedStock: accounts[0], selectedFutures: accounts[1] };
export const ensureAccounts = () => undefined;
export const useAccounts = () => state as never;
