const http = require('http');
const WebSocket = require('ws');
const express = require('express');
const bodyParser = require('body-parser');

// Express App for HTTP API
const app = express();
app.use(express.json());
app.use(bodyParser.json());

// In-memory storage for merchant-specific orders
const merchantOrders = {};
const merchantLastActivity = {}; // Track the last activity time for each merchant

// WebSocket server setup
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Map to associate multiple WebSocket connections with merchant IDs
const merchantSockets = new Map();

// WebSocket server: Handle merchant connections
wss.on('connection', (ws, req) => {
	console.log('WebSocket merchant connected');

	// Expect the merchant to send its merchantId after connecting
	ws.on('message', (message) => {
		try {
			const { type, merchantId } = JSON.parse(message);

			// Associate the WebSocket connection with the merchantId
			if (type === 'register' && merchantId) {
				console.log(`Merchant registered with ID: ${merchantId}`);
				if (!merchantSockets.has(merchantId)) {
					merchantSockets.set(merchantId, new Set());
				}
				merchantSockets.get(merchantId).add(ws);

				// Send existing orders for this merchant
				const orders = merchantOrders[merchantId] || [];
				ws.send(JSON.stringify({ elements: orders }));
			}
		} catch (error) {
			console.error('Error parsing message:', error);
		}
	});

	// Handle merchant disconnection
	ws.on('close', () => {
		console.log('WebSocket merchant disconnected');
		for (const [merchantId, socketSet] of merchantSockets.entries()) {
			if (socketSet.has(ws)) {
				socketSet.delete(ws);
				if (socketSet.size === 0) {
					merchantSockets.delete(merchantId);
				}
				break;
			}
		}
	});
});

// Function to send an order to all WebSocket connections of a specific merchant
const sendOrderToMerchant = (merchantId, ordersByDevice) => {
    const socketSet = merchantSockets.get(merchantId);
    if (socketSet) {
        for (const ws of socketSet) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ elements: ordersByDevice }));
            }
        }
    }
};

// HTTP API: Endpoint to receive orders from Android apps
app.post('/api/sync-orders-bulk', (req, res) => {
    const { merchantId, deviceId, orderJsonList } = req.body;

    if (!merchantId || !deviceId) {
        return res
            .status(400)
            .json({ error: 'merchantId and deviceId are required' });
    }

    console.log(`Received ${orderJsonList.length} orders from device ${deviceId}`);

    // Update the last activity time for the merchant
    merchantLastActivity[merchantId] = Date.now();

    // Initialize merchant's orders structure if not already done
    if (!merchantOrders[merchantId]) {
        merchantOrders[merchantId] = {};
    }

    // Store the order for the specific deviceId
    merchantOrders[merchantId][deviceId] = orderJsonList.sort(
        (a, b) => a.createdTime - b.createdTime
    );

	const allOrders = Object.values(merchantOrders[merchantId]).flatMap(deviceOrders => 
		Object.values(deviceOrders).flat()
	);

    // Notify the merchant via WebSocket
    sendOrderToMerchant(merchantId, allOrders);

    res.status(200).json({ success: true, orders: allOrders });
});

// HTTP API: Endpoint to fetch all orders for a specific merchant
app.get('/api/orders/:merchantId', (req, res) => {
    const { merchantId } = req.params;
    const ordersByDevice = merchantOrders[merchantId] || {};
    res.status(200).json(ordersByDevice);
});

// Scheduled task to clean up orders if a merchant has been inactive for more than one minute
const cleanUpInactiveMerchants = () => {
	console.log('Starting Cleaner Service');
    const oneMinuteAgo = Date.now() - 60000; // Current time minus one minute in milliseconds

    for (const merchantId in merchantLastActivity) {
        if (merchantLastActivity[merchantId] < oneMinuteAgo) {
            console.log(`Cleaning up orders for inactive merchant: ${merchantId}`);
            delete merchantOrders[merchantId];
            delete merchantLastActivity[merchantId];

            sendOrderToMerchant(merchantId, {});
        }
    }

};


setInterval(cleanUpInactiveMerchants, 3000);

// Start the server
const PORT = 8100;
server.listen(PORT, () => {
    console.log(`Server is running on http://0.0.0.0:${PORT}`);
});

