import fs from 'node:fs'
import { parseYaml, emitYaml, splitTopLevelItems, upsertPatchItem, findPatchItem } from '../lib/yamlish.mjs'

const file = process.env.DSH_HOME_PATCH || 'C:/Users/ADMIN/.dsh/profiles/desktop/cordis.patch.yml'
const text = fs.readFileSync(file, 'utf8')
const parsed = parseYaml(text)
console.log('items:', parsed.length, 'ids:', parsed.map((x) => x.id).join(','))
const round = parseYaml(emitYaml(parsed))
const same = JSON.stringify(round) === JSON.stringify(parsed)
console.log('emit round-trip equal:', same)
if (!same) {
  for (let i = 0; i < parsed.length; i += 1) {
    if (JSON.stringify(parsed[i]) !== JSON.stringify(round[i])) {
      console.log('DIFF item', i, parsed[i].id)
      console.log('orig', JSON.stringify(parsed[i]).slice(0, 600))
      console.log('round', JSON.stringify(round[i]).slice(0, 600))
    }
  }
}
const { items } = splitTopLevelItems(text)
console.log('split items:', items.length, 'all parsed:', items.every((x) => x.value && x.value.id))
const idsBefore = parsed.map((x) => x.id)
const up = upsertPatchItem(text, { id: 'theme-endfield', name: 'dsh-theme-endfield', config: { enabled: '1', palette: 'wuling', watermark: '0', list: ['a', 'b'], nested: { x: true, y: null } } })
const after = parseYaml(up.text)
console.log('upsert:', up.action, 'count:', after.length)
console.log('ids preserved:', JSON.stringify(after.map((x) => x.id)) === JSON.stringify(idsBefore))
console.log('config now:', JSON.stringify(findPatchItem(up.text, 'theme-endfield').config))
const ins = upsertPatchItem(text, { id: 'modpack-new', name: 'dsh-modpack', config: { a: 1 } })
const afterIns = parseYaml(ins.text)
console.log('insert:', ins.action, 'count:', afterIns.length, 'last:', afterIns[afterIns.length - 1].id)
