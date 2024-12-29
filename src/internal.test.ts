import { describe, expect, it } from '@effect/vitest'
import { Effect } from 'effect'
import { MulticastEffect } from './internal.js'

describe('MulticastEffect', () => {
  it.effect('ensures only one Effect is running at a time', () =>
    Effect.gen(function* () {
      let count = 0
      const effect = Effect.sync(() => {
        count++
        return count
      })

      const multicast = new MulticastEffect(effect)
      yield* Effect.all(
        Array.from({ length: 100 }, () => multicast),
        { concurrency: 'unbounded' },
      )
      expect(count).toBe(1)
      yield* Effect.all(
        Array.from({ length: 500 }, () => multicast),
        { concurrency: 'unbounded' },
      )
      expect(count).toBe(2)
    }).pipe(Effect.scoped),
  )
})
