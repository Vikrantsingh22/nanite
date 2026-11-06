"use client"

import * as React from "react"

import { api, ApiError } from "@/lib/api"
import type { UnlockedKeys } from "@/lib/onboarding-crypto"

import { decryptEntity, type Decrypted, type InboxPage, type MailEntity, type MailType } from "./mail"

export interface MailRow {
  entity: MailEntity
  /** undefined while decrypting */
  dec?: Decrypted
}

export type MailboxError = "not_found" | "upstream" | "network" | "failed"

const PAGE = 25

function errorKind(e: unknown): MailboxError {
  if (e instanceof ApiError) return e.status === 404 ? "not_found" : e.status === 502 ? "upstream" : e.status === 0 ? "network" : "failed"
  return "failed"
}

/**
 * Loads one agent's encrypted entities from the API and decrypts them in this tab.
 * Decrypted content lives only in React state and a ref cache; nothing is logged or persisted.
 * Polls the first page so new mail (and expiring OTPs) show up without a reload.
 */
export function useMailbox(agentId: string, keys: UnlockedKeys, type: MailType | undefined, pollMs = 8000) {
  const [rows, setRows] = React.useState<MailRow[] | null>(null)
  const [error, setError] = React.useState<MailboxError | null>(null)
  const [nextBefore, setNextBefore] = React.useState<number | undefined>()
  const [loadingMore, setLoadingMore] = React.useState(false)
  const cache = React.useRef(new Map<string, Decrypted>())
  const alive = React.useRef(true)

  const url = React.useCallback(
    (before?: number) =>
      `/mail/${encodeURIComponent(agentId)}/inbox?limit=${PAGE}${type ? `&type=${type}` : ""}${before !== undefined ? `&before=${before}` : ""}`,
    [agentId, type],
  )

  const toRows = React.useCallback(
    async (items: MailEntity[]): Promise<MailRow[]> => {
      await Promise.all(
        items.map(async (e) => {
          if (!cache.current.has(e.key)) cache.current.set(e.key, await decryptEntity(e, keys))
        }),
      )
      return items.map((entity) => ({ entity, dec: cache.current.get(entity.key)! }))
    },
    [keys],
  )

  /** First page: replaces the head of the list, keeps older pages that were loaded with "Load older". */
  const reload = React.useCallback(async () => {
    try {
      const page = await api<InboxPage>(url())
      const head = await toRows(page.items)
      if (!alive.current) return
      setRows((old) => {
        const last = head[head.length - 1]
        const tail = old && last && page.nextBefore !== undefined ? old.filter((r) => r.entity.receivedAt < last.entity.receivedAt) : []
        return [...head, ...tail]
      })
      setNextBefore((prev) => (prev !== undefined && page.nextBefore !== undefined ? prev : page.nextBefore))
      setError(null)
    } catch (e) {
      if (alive.current) setError(errorKind(e))
    }
  }, [url, toRows])

  const loadMore = React.useCallback(async () => {
    if (nextBefore === undefined) return
    setLoadingMore(true)
    try {
      const page = await api<InboxPage>(url(nextBefore))
      const more = await toRows(page.items)
      if (!alive.current) return
      setRows((old) => [...(old ?? []), ...more.filter((m) => !old?.some((o) => o.entity.key === m.entity.key))])
      setNextBefore(page.nextBefore)
    } catch (e) {
      if (alive.current) setError(errorKind(e))
    } finally {
      if (alive.current) setLoadingMore(false)
    }
  }, [nextBefore, url, toRows])

  /** Update one entity's metadata in place (e.g. its expiry after Keep), without re-decrypting. */
  const patchEntity = React.useCallback((key: string, patch: Partial<MailEntity>) => {
    setRows((old) => old?.map((r) => (r.entity.key === key ? { ...r, entity: { ...r.entity, ...patch } } : r)) ?? old)
  }, [])

  React.useEffect(() => {
    alive.current = true
    const map = cache.current
    // Each panel is mounted per (agent, tab), so state starts empty; no reset needed here.
    const first = setTimeout(() => void reload(), 0)
    const id = setInterval(() => void reload(), pollMs)
    return () => {
      alive.current = false
      clearTimeout(first)
      clearInterval(id)
      map.clear()
    }
  }, [reload, pollMs])

  return { rows, error, hasMore: nextBefore !== undefined, loadingMore, loadMore, reload, patchEntity }
}
