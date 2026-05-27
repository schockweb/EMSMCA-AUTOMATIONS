"""
Dead Letter Queue setup — declares the DLX exchange and dead letter queue
in RabbitMQ when the Celery worker starts.

Messages that fail permanently (rejected, timed out, or nacked without requeue)
are routed here for admin review via the dashboard.
"""
import logging
from celery.signals import worker_ready

logger = logging.getLogger("ems.dlq")


@worker_ready.connect
def setup_dead_letter_queue(sender=None, **kwargs):
    """Declare the DLX exchange and dead_letter queue on worker startup.

    This runs once per worker boot. Uses the raw kombu connection
    from the Celery app to declare RabbitMQ objects directly.
    """
    try:
        from app.tasks.celery_app import celery_app

        with celery_app.connection() as conn:
            channel = conn.channel()

            # Declare the dead letter exchange (direct type)
            channel.exchange_declare(
                exchange="ems_dlx",
                type="direct",
                durable=True,
                auto_delete=False,
            )

            # Declare the dead letter queue
            channel.queue_declare(
                queue="ems_dead_letter",
                durable=True,
                auto_delete=False,
            )

            # Bind queue to exchange
            channel.queue_bind(
                queue="ems_dead_letter",
                exchange="ems_dlx",
                routing_key="ems_dead_letter",
            )

            logger.info(
                "[DLQ] Dead letter exchange 'ems_dlx' and queue 'ems_dead_letter' "
                "declared and bound successfully."
            )
    except Exception as e:
        logger.error("[DLQ] Failed to set up dead letter queue: %s", e)
