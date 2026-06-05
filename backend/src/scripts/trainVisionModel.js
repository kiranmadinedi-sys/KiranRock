const tf = require('@tensorflow/tfjs-node');
const path = require('path');
const dataProvider = require('../services/dataProvider'); // Assuming this can fetch historical data
const logger = require('../utils/logger');

const MODEL_PATH = path.join(__dirname, '../src/ml-models/vision-model');
const SEQUENCE_LENGTH = 60; // How many days of data to look at for each prediction
const PREDICTION_HORIZON = 5; // How many days into the future to predict

/**
 * @fileoverview
 * VISION Model Training Script
 *
 * This script is responsible for training the LSTM model that the VISION service uses.
 * It should be run manually and periodically (e.g., once a month) to retrain the
 * model on the latest market data.
 *
 * To run: `node backend/src/scripts/trainVisionModel.js`
 */

/**
 * Fetches and prepares the training data.
 */
async function getTrainingData() {
  logger.info('[Trainer] Fetching historical data for SPY (5 years)...');
  // Fetch a long history of data for a broad market index to train the model.
  const historicalData = await dataProvider.getBars('SPY', '1d', 365 * 5);
  const closes = historicalData.map(d => d.close);

  logger.info(`[Trainer] Fetched ${closes.length} data points.`);

  const sequences = [];
  const labels = [];

  for (let i = 0; i < closes.length - SEQUENCE_LENGTH - PREDICTION_HORIZON; i++) {
    // Input sequence
    const sequence = closes.slice(i, i + SEQUENCE_LENGTH);
    const firstPrice = sequence[0];
    const normalizedSequence = sequence.map(p => (p / firstPrice) - 1);
    sequences.push(normalizedSequence);

    // Output label (the price change `PREDICTION_HORIZON` days later)
    const futurePrice = closes[i + SEQUENCE_LENGTH + PREDICTION_HORIZON];
    const currentPrice = closes[i + SEQUENCE_LENGTH - 1];
    const label = (futurePrice - currentPrice) / currentPrice;
    labels.push(label);
  }

  const xs = tf.tensor2d(sequences, [sequences.length, SEQUENCE_LENGTH]).reshape([-1, SEQUENCE_LENGTH, 1]);
  const ys = tf.tensor1d(labels);

  return { xs, ys };
}

/**
 * Defines the LSTM model architecture.
 */
function createModel() {
  const model = tf.sequential();

  // Layer 1: LSTM with 50 units. `inputShape` is [timesteps, features].
  model.add(tf.layers.lstm({
    units: 50,
    returnSequences: true,
    inputShape: [SEQUENCE_LENGTH, 1]
  }));
  model.add(tf.layers.dropout({ rate: 0.2 }));

  // Layer 2: Another LSTM layer.
  model.add(tf.layers.lstm({ units: 50, returnSequences: false }));
  model.add(tf.layers.dropout({ rate: 0.2 }));

  // Layer 3: A standard dense layer.
  model.add(tf.layers.dense({ units: 25 }));

  // Output Layer: A single neuron that will output the predicted price change.
  model.add(tf.layers.dense({ units: 1 }));

  // Compile the model with a loss function and an optimizer.
  model.compile({
    optimizer: 'adam',
    loss: 'meanSquaredError' // Good for regression problems like price prediction
  });

  logger.info('[Trainer] LSTM model created successfully.');
  model.summary();
  return model;
}

/**
 * Main function to run the training process.
 */
async function runTraining() {
  logger.info('[Trainer] Starting VISION model training...');

  const { xs, ys } = await getTrainingData();
  const model = createModel();

  logger.info('[Trainer] Beginning model training... This may take several minutes.');

  await model.fit(xs, ys, {
    epochs: 50, // How many times to go through the data
    batchSize: 32,
    shuffle: true,
    callbacks: {
      onEpochEnd: (epoch, logs) => {
        logger.info(`[Trainer] Epoch ${epoch + 1}/50 - Loss: ${logs.loss.toFixed(4)}`);
      }
    }
  });

  logger.info('[Trainer] Model training complete.');

  // Save the trained model to the specified path.
  await model.save(`file://${MODEL_PATH}`);
  logger.info(`[Trainer] Model saved to: ${MODEL_PATH}`);
}

runTraining().catch(err => {
  logger.error('[Trainer] An error occurred during training:', err);
});
