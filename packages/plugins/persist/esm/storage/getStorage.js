function noop() {
    return Promise.resolve();
}
const noopStorage = {
    getItem: noop,
    setItem: noop,
    removeItem: noop,
};
function hasStorage(storageType) {
    if (typeof globalThis !== 'object' || !(storageType in globalThis)) {
        return false;
    }
    try {
        const storage = globalThis[storageType];
        const testKey = `persist ${storageType} test`;
        storage.setItem(testKey, 'test');
        storage.getItem(testKey);
        storage.removeItem(testKey);
    }
    catch (e) {
        if (process.env.NODE_ENV === 'development')
            console.warn(`persist ${storageType} test failed, persistence will be disabled.`);
        return false;
    }
    return true;
}
export default function getStorage(type) {
    const storageType = `${type}Storage`;
    if (hasStorage(storageType))
        return globalThis[storageType];
    else {
        if (process.env.NODE_ENV === 'development') {
            console.error(`persist failed to create sync storage. falling back to noop storage.`);
        }
        return noopStorage;
    }
}