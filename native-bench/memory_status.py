import ctypes
from ctypes import wintypes

class MemoryStatus(ctypes.Structure):
    _fields_ = [("length", wintypes.DWORD), ("load", wintypes.DWORD)] + [
        (name, ctypes.c_ulonglong) for name in
        ["total", "available", "total_page", "available_page", "total_virtual", "available_virtual", "extended"]
    ]

def memory_status():
    status = MemoryStatus()
    status.length = ctypes.sizeof(status)
    ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))
    return {"total_GiB": status.total / 2**30, "available_GiB": status.available / 2**30}

if __name__ == "__main__":
    print(memory_status())
    import ifcopenshell
    print("IfcOpenShell", ifcopenshell.version)
