"""Noxem Hermes plugin - Memory provider for Hermes Agent."""

from .plugin import NoxemMemoryPlugin, register as plugin_register
from .memory_provider import NoxemMemoryProvider, register as provider_register

__version__ = "0.3.0"
__all__ = [
    "NoxemMemoryPlugin",
    "NoxemMemoryProvider",
    "plugin_register",
    "provider_register",
]
