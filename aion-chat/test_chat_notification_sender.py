import sys
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import ws as ws_module


class WebSocketNotificationSenderTests(unittest.TestCase):
    def test_broadcast_payload_adds_configured_sender_to_private_assistant_message(self):
        event = {
            "type": "msg_created",
            "data": {
                "id": "msg_test",
                "conv_id": "conv_test",
                "role": "assistant",
                "content": "hello",
            },
        }

        with patch("ws.load_worldbook", return_value={"ai_name": "Configured Companion"}):
            enriched = ws_module._with_private_notification_sender(event)

        self.assertEqual(enriched["data"]["sender"], "Configured Companion")
        self.assertEqual(enriched["data"]["sender_name"], "Configured Companion")
        self.assertNotIn("sender", event["data"])

    def test_broadcast_payload_keeps_chatroom_message_sender_unchanged(self):
        event = {
            "type": "chatroom_msg_created",
            "data": {
                "id": "cm_test",
                "room_id": "room_test",
                "sender": "aion",
                "content": "hello",
            },
        }

        enriched = ws_module._with_private_notification_sender(event)

        self.assertEqual(enriched["data"]["sender"], "aion")
        self.assertNotIn("sender_name", enriched["data"])


if __name__ == "__main__":
    unittest.main()
