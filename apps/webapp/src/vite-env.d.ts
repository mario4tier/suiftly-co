/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MOCK_WALLET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
