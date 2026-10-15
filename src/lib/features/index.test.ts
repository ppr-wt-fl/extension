import { expect, test } from 'vitest'
import { extract, inlineScripts, presets, type RequestInfo } from '.'

const request: RequestInfo = {
  url: 'https://cdn.example.com/static/app.js',
  topLevelUrl: 'https://www.example.com/',
  type: 'script',
  body: "var a = localStorage.getItem('x'); fetch('https://t.example/'+a);",
}

test('rejects unknown names', () => {
  for (const name of ['nope', 'req_url_200', 'fqdn_30']) {
    expect(() => extract([name], request), name).toThrow(`unknown feature ${name}`)
  }
})

test('keeps order', () => {
  const forward = Array.from(extract(presets.adflush, request))
  const backward = Array.from(extract([...presets.adflush].reverse(), request))
  expect(backward).toEqual(forward.reverse())
})

test('mixes TS and Rust features', () => {
  const ts = new Map([['url_has_query', (req: RequestInfo) => Number(req.url.includes('?'))]])
  const values = extract(['url_length', 'url_has_query', 'is_third_party'], { ...request, url: 'https://a.example/?q' }, ts)
  expect(Array.from(values)).toEqual([20, 1, 1])
})

test('inlineScripts', () => {
  const html = '<script>a()</script>\r\n<script src="x.js"></script><script>\r\nb()\r\n</script>'
  expect(inlineScripts(html)).toEqual(['a()', '\nb()\n'])
})
