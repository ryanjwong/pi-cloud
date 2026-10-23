export const outbox = <A>(send: (items: Array<A>) => Promise<void>) => {
  const queue: Array<A> = []
  let flight: Promise<void> | undefined
  const drain = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    try {
      while (queue.length > 0) await send(queue.splice(0))
    } finally {
      flight = undefined
    }
  }
  return (items: ReadonlyArray<A>): Promise<void> => {
    queue.push(...items)
    return flight ??= drain()
  }
}
