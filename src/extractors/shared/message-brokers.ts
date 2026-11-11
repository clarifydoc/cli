import type { DataSourceInfo } from "../../types/analysis.js";

/**
 * The message broker a queue row names, from what its extractor labelled it
 * (`Kafka: send`, `RabbitMQ: basicPublish`, `Celery: task`, `SQS: receive`).
 * An extractor that knows its broker for certain sets `DataSourceInfo.broker`
 * itself; this reads the label of the rest, so one table serves every plugin.
 * A label that names no broker (`MQ: send`) answers `undefined`.
 */
const BROKER_BY_LABEL: Array<[RegExp, string]> = [
  [/^(?:RabbitMQ|AMQP)\b/i, "amqp"],
  [/kafka|sarama/i, "kafka"],
  [/^SQS\b/i, "sqs"],
  [/^SNS\b/i, "sns"],
  [/^AWS:\s*(?:\w*Sqs|SendMessage|ReceiveMessage)/i, "sqs"],
  [/^BullMQ\b/i, "bullmq"],
  [/^Celery\b/i, "celery"],
  [/^Redis\b/i, "redis"],
  [/^MQTT\b/i, "mqtt"],
  [/^Socket\.IO\b/i, "socket.io"],
  [/^Phoenix/i, "phoenix"],
  [/^Dapr\b/i, "dapr"],
  [/^NServiceBus\b/i, "nservicebus"],
  [/^ActiveJob\b/i, "activejob"],
  [/^Oban\b/i, "oban"],
  [/^(?:EventEmitter|NestJS|EVT|Event|ApplicationListener)/, "events"],
];

/** The broker of one queue row: its own `broker`, else the one its label names. */
export function brokerOfRow(ds: Pick<DataSourceInfo, "broker" | "name">): string | undefined {
  if (ds.broker) return ds.broker.toLowerCase();
  for (const [re, broker] of BROKER_BY_LABEL) if (re.test(ds.name)) return broker;
  return undefined;
}

/**
 * The broker for a Spring messaging template, from its declared type or the
 * receiver's name (`rabbitTemplate`, `KafkaTemplate<String, Match>`, `jmsTemplate`).
 */
export function brokerOfTemplate(declaredType: string | null, receiver: string): string | undefined {
  const text = `${declaredType ?? ""} ${receiver}`;
  if (/rabbit|amqp/i.test(text)) return "amqp";
  if (/kafka/i.test(text)) return "kafka";
  if (/jms/i.test(text)) return "jms";
  return undefined;
}
