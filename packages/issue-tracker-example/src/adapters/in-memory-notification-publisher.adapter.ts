import { Effect, Layer } from "effect"
import { NotificationPublisher } from "../ports/notification-publisher.port.js"

export const InMemoryNotificationPublisherLive = Layer.succeed(NotificationPublisher, {
  issueAssigned: () => Effect.void,
})
