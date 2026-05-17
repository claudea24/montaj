import nextVitals from "eslint-config-next/core-web-vitals";

const config = [
  {
    // Worker has its own tsconfig and runs under tsx (not Next.js); the
    // root ESLint config would flag its .ts import-path style.
    ignores: ["worker/**"],
  },
  ...nextVitals,
  {
    rules: {
      "@next/next/no-img-element": "off",
    },
  },
];

export default config;
