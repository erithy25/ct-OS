/**
 * Collapse the `vite build --mode singlefile` output into one HTML file
 * (dist-single/panopticon-single.html) with the bundle + styles inlined —
 * for hosting the demo anywhere a lone HTML file can go.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist-single')
let html = readFileSync(resolve(dist, 'index.html'), 'utf8')

// inline the stylesheet(s)
html = html.replace(/<link rel="stylesheet"[^>]*href="\.?\/?(assets\/[^"]+\.css)"[^>]*>/g, (_, href) => {
  const css = readFileSync(resolve(dist, href), 'utf8')
  return `<style>\n${css}\n</style>`
})

// inline the module bundle (escape any </script> occurrences inside the JS)
html = html.replace(/<script type="module"[^>]*src="\.?\/?(assets\/[^"]+\.js)"[^>]*><\/script>/g, (_, src) => {
  const js = readFileSync(resolve(dist, src), 'utf8').replace(/<\/script/g, '<\\/script')
  return `<script type="module">\n${js}\n</script>`
})

writeFileSync(resolve(dist, 'panopticon-single.html'), html)
console.log(`wrote dist-single/panopticon-single.html (${(html.length / 1024 / 1024).toFixed(1)} MB)`)
