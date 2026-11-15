/**
 * dsh-modpack —— 兼容性检查。
 *
 * 只报「确定能判断的」问题：peer 依赖在不在、版本满不满足、engines 对不对、
 * license 允不允许、同 id 的配置会不会被覆盖。判断不了的一律说「无法判断」，
 * 不装作通过——安装包最怕的就是假绿灯。
 */
import { satisfies, parseVersion, compareVersions } from './semver.mjs'

const HOST_SCOPE = /^@deepseek-ai\//u

function versionOf(map, name) {
  const hit = map.get(name)
  return hit ? hit.version : null
}

/**
 * @param {object[]} plugins 清单里的插件条目
 * @param {object} context {installed: object[], dshVersion, nodeVersion, config}
 */
export function checkCompatibility(plugins, context) {
  const installedMap = new Map((context.installed || []).map((p) => [p.name, p]))
  const packMap = new Map((plugins || []).map((p) => [p.name, p]))
  const findings = []
  const add = (level, plugin, code, message, suggestion) => findings.push({ level, plugin, code, message, suggestion })
  const dshVersion = context.dshVersion || ''
  const nodeVersion = context.nodeVersion || process.versions.node
  const allow = new Set((context.config?.licenseAllow || []).map((x) => String(x).toLowerCase()))

  for (const plugin of plugins || []) {
    const local = installedMap.get(plugin.name)
    if (local) {
      if (local.version !== plugin.version) {
        const cmp = compareVersions(plugin.version, local.version)
        add('info', plugin.name, 'local-version',
          '本地已装 ' + local.version + '，整合包里是 ' + plugin.version + (cmp === null ? '' : cmp > 0 ? '（较新）' : cmp < 0 ? '（较旧，可能降级）' : ''),
          cmp !== null && cmp < 0 ? '确认要降级再装；降级可能丢掉新版本的配置项。' : '安装会按整合包里的版本处理。')
      }
      if (!local.isBundle && plugin.isBundle) {
        add('warn', plugin.name, 'local-not-bundle', '本地同名包不是 DSH 插件（没有 dsh 段）', '确认整合包来源；装完可能不会出现在侧栏。')
      }
    } else {
      add('info', plugin.name, 'not-installed', '本地未安装，将新增', '')
    }

    const peers = plugin.peerDependencies || {}
    for (const [peer, range] of Object.entries(peers)) {
      if (HOST_SCOPE.test(peer)) continue
      const inPack = packMap.get(peer)
      const inLocal = installedMap.get(peer)
      const found = inPack ? inPack.version : inLocal ? inLocal.version : null
      if (!found) {
        add('warn', plugin.name, 'peer-missing-' + peer,
          '需要 ' + peer + ' ' + range + '，整合包和本机都没有',
          '安装后这个插件可能报错或功能缺失；把它一起打包进来。')
        continue
      }
      const ok = satisfies(found, range)
      if (ok === false) {
        add('error', plugin.name, 'peer-conflict-' + peer,
          '需要 ' + peer + ' ' + range + '，实际是 ' + found + '（版本冲突）',
          '换成满足范围的 ' + peer + ' 版本，或把整合包里那个插件换版本。')
      } else if (ok === null) {
        add('info', plugin.name, 'peer-unknown-' + peer, 'peer 范围看不懂：' + peer + ' ' + range, '请人工确认。')
      }
    }

    const engines = plugin.engines || {}
    if (engines.dsh && dshVersion) {
      const ok = satisfies(dshVersion, String(engines.dsh))
      if (ok === false) {
        add('error', plugin.name, 'engines-dsh', '要求 DSH ' + engines.dsh + '，本机是 ' + dshVersion,
          '先升级 DSH 再装，或换一个兼容的插件版本。')
      } else if (ok === null) {
        add('info', plugin.name, 'engines-dsh-unknown', 'engines.dsh 看不懂：' + engines.dsh, '')
      }
    }
    if (engines.node && nodeVersion) {
      const ok = satisfies(String(nodeVersion), String(engines.node))
      if (ok === false) {
        add('error', plugin.name, 'engines-node', '要求 Node ' + engines.node + '，本机是 ' + nodeVersion,
          'DSH 自带 Node 版本不可换；请找兼容的插件版本。')
      }
    }

    if (!plugin.license) {
      add('warn', plugin.name, 'license-missing', '插件没写 license', '再分发前请联系作者确认授权，否则不要传给别人。')
    } else if (!allow.has(String(plugin.license).toLowerCase())) {
      add('warn', plugin.name, 'license-unlisted', 'license 不在允许列表：' + plugin.license,
        '确认许可允许再分发；不确定就只在自己机器上装。')
    }
    if (plugin.localEdits) {
      add('info', plugin.name, 'local-edits', '打包时带的是打包者改过的本地文件', '和上游发布的版本可能不一致。')
    }
    if (!plugin.hasClient && !plugin.hasPatch && plugin.isBundle === false) {
      add('warn', plugin.name, 'not-bundle', '这个包没有 dsh 段，可能不是 DSH 插件', '确认是不是装错了东西。')
    }
  }

  const errors = findings.filter((f) => f.level === 'error')
  const warns = findings.filter((f) => f.level === 'warn')
  return {
    findings,
    blocking: errors.length > 0,
    counts: { error: errors.length, warn: warns.length, info: findings.length - errors.length - warns.length },
    summary: errors.length > 0
      ? '有 ' + errors.length + ' 个必须处理的问题，' + warns.length + ' 个提醒'
      : warns.length > 0
        ? '可以装，但有 ' + warns.length + ' 个提醒'
        : '没发现兼容问题',
  }
}
