export declare const persistModel: import("doura/esm/core/defineModel").DefineModel<"_persist", {
    rehydrated: boolean;
    version: number;
}, {
    purge(): Promise<any>;
    flush(): Promise<any>;
    togglePause(): void;
}, import("doura/esm/core/modelOptions").ViewOptions, {}>;