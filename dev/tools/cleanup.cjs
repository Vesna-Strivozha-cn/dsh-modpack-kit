const fs = require('fs')
const targets = [
  'D:/桌面/蛆/_tools',
  'D:/桌面/蛆/_dshdocs',
  'C:/Users/ADMIN/.dsh/whale-work/plugins/dsh-modpack',
]
for (const t of targets) {
  if (!fs.existsSync(t)) { console.log('skip (missing):', t); continue }
  fs.rmSync(t, { recursive: true, force: true })
  console.log('removed:', t, fs.existsSync(t) ? '(still there!)' : 'ok')
}
console.log('整合包 内容:', fs.readdirSync('D:/桌面/蛆/整合包').join(' '))
