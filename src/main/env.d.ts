// electron-vite copies `?asset` imports into the build output and rewrites them
// to a runtime path, so the app icon ships inside the package. Declare the type.
declare module '*?asset' {
  const src: string
  export default src
}
