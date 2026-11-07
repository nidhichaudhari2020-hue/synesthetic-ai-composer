"""Small autoregressive melody LSTM; train with categorical cross-entropy."""
import torch
from torch import nn

from .tokenizer import VOCAB_SIZE


class MelodyLSTM(nn.Module):
    def __init__(self, embedding_dim: int = 64, hidden_dim: int = 128, layers: int = 2):
        super().__init__()
        self.architecture = {"embedding_dim": embedding_dim, "hidden_dim": hidden_dim, "layers": layers}
        self.embedding = nn.Embedding(VOCAB_SIZE, embedding_dim)
        self.recurrent = nn.LSTM(embedding_dim, hidden_dim, layers, batch_first=True,
                                 dropout=0.15 if layers > 1 else 0.0)
        self.output = nn.Linear(hidden_dim, VOCAB_SIZE)

    def forward(self, tokens: torch.Tensor, state=None):
        hidden, state = self.recurrent(self.embedding(tokens), state)
        return self.output(hidden), state
