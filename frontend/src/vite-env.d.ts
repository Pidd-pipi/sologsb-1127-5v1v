/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_AMAP_KEY?: string;
  /** 同步服务基址，默认 /api（由 nginx 或 vite 代理） */
  readonly VITE_SYNC_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
