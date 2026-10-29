// esbuild css 로더로 번들되는 CSS side-effect import 선언.
declare module '*.css';

/** 제목줄 로고(logo1 40×40 축소본) data URL. scripts/build.mjs의 esbuild define으로 넣는다. */
declare const __LOGO_DATA_URL__: string;
