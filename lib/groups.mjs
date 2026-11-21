/**
 * dsh-modpack —— 读插件市场的分组（只读，不改人家的状态文件）。
 *
 * 插件市场把用户自建的分组存在 profile 下的 `.dsh-market/state.json`
 * （`groups` 名字到成员、`groupOrder` 顺序、`disabled` 停用名单）。分组只是
 * 「哪些插件一起看」的整理信息，不决定启用状态，所以这里也只读不写：
 * 打包时按分组批量勾选，装包时按市场自己的规则走。
 *
 * 市场没装、没建过分组、状态文件坏了，都退回「没有分组」——不让一个可选
 * 的整理功能变成打包的前置条件。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 市场状态文件的固定位置（profile 根下）。 */
export function marketStatePath(profileDir) {
  return path.join(profileDir, '.dsh-market', 'state.json')
}

function stringList(value) {
  if (!Array.isArray(value)) return []
  const out = []
  for (const item of value) {
    if (typeof item !== 'string' || item === '' || out.includes(item)) continue
    out.push(item)
  }
  return out
}

/**
 * 读市场分组。返回 `{present, order, groups, disabled}`；
 * `groups` 的成员已去重、去掉空串，但不判断装没装（那一步交给 groupViews）。
 */
export function readMarketGroups(profileDir) {
  const empty = { present: false, order: [], groups: {}, disabled: [] }
  if (typeof profileDir !== 'string' || profileDir === '') return empty
  let raw = null
  try {
    raw = JSON.parse(fs.readFileSync(marketStatePath(profileDir), 'utf8'))
  } catch {
    return empty
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return empty
  const groups = {}
  const source = raw.groups !== null && typeof raw.groups === 'object' && !Array.isArray(raw.groups) ? raw.groups : {}
  for (const [name, members] of Object.entries(source)) {
    if (name === '') continue
    groups[name] = stringList(members)
  }
  const order = stringList(raw.groupOrder).filter((name) => groups[name] !== undefined)
  for (const name of Object.keys(groups)) if (!order.includes(name)) order.push(name)
  return { present: true, order, groups, disabled: stringList(raw.disabled) }
}

/**
 * 把本机插件按市场分组的视角切开：分组在前（按市场的顺序），剩下的归
 * 「未分组」。成员里已经卸掉的插件记进 `missing`，不混进列表。
 *
 * @param {object[]} installed listInstalled() 的结果（含 name）
 * @param {{order: string[], groups: Record<string, string[]>}} market readMarketGroups() 的结果
 */
export function groupViews(installed, market) {
  const names = new Set((installed || []).map((item) => item.name))
  const claimed = new Set()
  const groups = []
  for (const name of (market && market.order) || []) {
    const members = ((market && market.groups && market.groups[name]) || []).filter((member) => names.has(member))
    const missing = ((market && market.groups && market.groups[name]) || []).filter((member) => !names.has(member))
    for (const member of members) claimed.add(member)
    groups.push({ name, members, missing })
  }
  const ungrouped = (installed || []).map((item) => item.name).filter((name) => !claimed.has(name))
  return { groups, ungrouped }
}
