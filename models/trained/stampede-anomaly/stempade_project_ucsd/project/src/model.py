"""The hybrid CNN-LSTM of pipeline.md Sec. 7 (paper Tables 1 and 2)."""
from __future__ import annotations

import tensorflow as tf
from tensorflow.keras import layers, models

from config import (CNN_BOTTLENECK, CNN_FILTERS, DENSE_UNITS, DROPOUT, FRAME_H,
                    FRAME_W, LEARNING_RATE, LOSS, LSTM_UNITS, NUM_CLASSES,
                    SCALAR_BITS, SEQ_LEN)

SCALAR_DIM = 4 * SCALAR_BITS   # 32-bit binary vector per frame


def apply_cnn_branch(x):
    """Per-frame spatial encoder, paper Table 1, applied across the time axis.

    Conv(32) - BN - Pool - Conv(64) - Pool - Conv(128) - BN - Pool - Flatten,
    giving 28*28*128 = 100,352 features per frame.

    Each layer is wrapped in TimeDistributed individually rather than wrapping a
    sub-Model: Keras 3's TimeDistributed cannot infer the output shape of a
    nested Functional model.
    """
    f1, f2, f3 = CNN_FILTERS
    td = layers.TimeDistributed

    x = td(layers.Conv2D(f1, 3, padding="same", activation="relu"), name="conv1")(x)
    x = td(layers.BatchNormalization(), name="bn1")(x)
    x = td(layers.MaxPooling2D(2), name="pool1")(x)

    x = td(layers.Conv2D(f2, 3, padding="same", activation="relu"), name="conv2")(x)
    x = td(layers.MaxPooling2D(2), name="pool2")(x)

    x = td(layers.Conv2D(f3, 3, padding="same", activation="relu"), name="conv3")(x)
    x = td(layers.BatchNormalization(), name="bn3")(x)
    x = td(layers.MaxPooling2D(2), name="pool3")(x)

    x = td(layers.Flatten(), name="flatten")(x)   # 100,352 -- paper Table 1

    if CNN_BOTTLENECK:
        # [gap - required fix] Feeding 100,352 features straight into a
        # 256-unit LSTM is 4*(100352+256+1)*256 ~= 103M parameters in that one
        # layer, which contradicts both the reported 12 GB training GPU and the
        # 0.078 s/frame CPU inference.  Table 1 shows no projection; one is
        # added here.  Set CNN_BOTTLENECK = 0 to build the literal paper spec.
        x = td(layers.Dense(CNN_BOTTLENECK, activation="relu"), name="bottleneck")(x)

    return x


def build_model(seq_len: int = SEQ_LEN, use_scalars: bool = True) -> models.Model:
    """Full dual-input CNN-LSTM.

    Inputs
      flow    (T, 224, 224, 2)  normalised to [-1, 1]
      scalars (T, 32)           binarised motion descriptors
    Output
      (4,) softmax over normal / moderate / dense / risky
    """
    flow_in = layers.Input(shape=(seq_len, FRAME_H, FRAME_W, 2), name="flow")
    inputs = [flow_in]

    x = apply_cnn_branch(flow_in)

    if use_scalars:
        scalar_in = layers.Input(shape=(seq_len, SCALAR_DIM), name="scalars")
        inputs.append(scalar_in)
        # Per-timestep concatenation, paper Sec. 7.3: "the concatenated features
        # from both branches are processed through LSTM layers".
        x = layers.Concatenate(axis=-1, name="fusion")([x, scalar_in])

    u1, u2 = LSTM_UNITS
    x = layers.LSTM(u1, return_sequences=True, name="lstm_1")(x)
    x = layers.Dropout(DROPOUT)(x)
    x = layers.LSTM(u2, return_sequences=False, name="lstm_2")(x)
    x = layers.Dropout(DROPOUT)(x)

    x = layers.Dense(DENSE_UNITS, activation="relu")(x)
    x = layers.BatchNormalization()(x)
    out = layers.Dense(NUM_CLASSES, activation="softmax", name="risk")(x)

    return models.Model(inputs, out, name="stampede_cnn_lstm")


def build_baseline_3dcnn(seq_len: int = SEQ_LEN) -> models.Model:
    """Lightweight 3D-CNN baseline for the ablation the paper promises in Sec. 7.

    The paper says ablations comparing (i) CNN-LSTM with scalars, (ii) without
    scalars, and (iii) a lightweight 3D CNN "will be applied", but never reports
    them.  (i) and (ii) come from build_model(use_scalars=...); this is (iii).
    """
    inp = layers.Input(shape=(seq_len, FRAME_H, FRAME_W, 2), name="flow")
    x = inp
    for f in CNN_FILTERS:
        x = layers.Conv3D(f, 3, padding="same", activation="relu")(x)
        x = layers.BatchNormalization()(x)
        x = layers.MaxPooling3D((1, 2, 2))(x)
    x = layers.GlobalAveragePooling3D()(x)
    x = layers.Dense(DENSE_UNITS, activation="relu")(x)
    x = layers.Dropout(DROPOUT)(x)
    out = layers.Dense(NUM_CLASSES, activation="softmax", name="risk")(x)
    return models.Model(inp, out, name="baseline_3dcnn")


def compile_model(model: models.Model, lr: float = LEARNING_RATE) -> models.Model:
    """Adam @ 1e-3, categorical cross-entropy, accuracy -- paper Table 3."""
    model.compile(
        optimizer=tf.keras.optimizers.Adam(learning_rate=lr),
        loss=LOSS,
        metrics=["accuracy"],
    )
    return model
