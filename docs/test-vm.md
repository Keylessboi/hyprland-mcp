# Test VM Setup

This document explains how to set up the test VM for Hyprland MCP. The VM gives the MCP server a safe place to run live tests. The server can move windows, send input, and take screenshots in the VM without touching your real desktop.

## Why a VM

The MCP server controls a Hyprland desktop. Live testing on a real desktop is risky. A mistake can move your windows, steal focus, or close the wrong app. A VM removes that risk. The VM has its own Hyprland session. The server tests against that session. Your desktop stays untouched.

## Host requirements

The host needs these packages:

- `qemu-full` (QEMU with KVM support)
- `libvirt` (the VM manager)
- `virt-install` (the VM installer)
- `edk2-ovmf` (UEFI firmware)
- `arch-install-scripts` (pacstrap, arch-chroot)

Check that KVM works before you start:

```sh
ls -la /dev/kvm
```

The device must exist. Without it, the VM runs without acceleration and is too slow.

## Create the VM disk

```sh
sudo qemu-img create -f qcow2 /var/lib/libvirt/images/hyprland-vm.qcow2 25G
sudo modprobe nbd max_part=8
sudo qemu-nbd --connect=/dev/nbd0 /var/lib/libvirt/images/hyprland-vm.qcow2
```

The host is Arch Linux. This lets us install the VM system directly into the disk image with pacstrap. We do not need the interactive installer.

## Partition and format

```sh
sudo parted -s /dev/nbd0 mklabel gpt
sudo parted -s /dev/nbd0 mkpart ESP fat32 1MiB 513MiB
sudo parted -s /dev/nbd0 set 1 esp on
sudo parted -s /dev/nbd0 mkpart primary ext4 513MiB 100%
sudo mkfs.fat -F32 /dev/nbd0p1
sudo mkfs.ext4 -q /dev/nbd0p2
sudo mount /dev/nbd0p2 /mnt/vmroot
sudo mount /dev/nbd0p1 /mnt/vmroot/boot
```

Refresh the package database first. A stale database causes 404 errors:

```sh
sudo pacman -Syy
```

## Install the base system

```sh
sudo pacstrap -K /mnt/vmroot base linux linux-firmware \
  networkmanager openssh sudo vim hyprland grim slurp \
  ydotool wtype wl-clipboard kitty python python-pip
```

## Configure the guest

```sh
sudo arch-chroot /mnt/vmroot bash -c '
  genfstab -U /mnt/vmroot > /etc/fstab
  echo "hyprtest" > /etc/hostname
  echo "en_US.UTF-8 UTF-8" > /etc/locale.gen
  locale-gen
  echo "root:hyprtest" | chpasswd
  useradd -m -G wheel,input,seat,video -s /bin/bash tester
  echo "tester:hyprtest" | chpasswd
  echo "%wheel ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/wheel
  systemctl enable NetworkManager sshd seatd
'
```

The `tester` user needs three groups:

- `input` — for ydotool (uinput device access)
- `seat` — for seatd (session access for the compositor)
- `video` — for the DRM device (`/dev/dri/card1`)

Without the `video` group, Hyprland fails at startup. EGL cannot open the card. The error is `CBackend::create() failed!`.

Add the ydotool udev rule:

```sh
cat > /mnt/vmroot/etc/udev/rules.d/80-ydotool.rules << "EOF"
KERNEL=="uinput", GROUP="input", MODE="0660"
EOF
```

## Install the bootloader

```sh
sudo arch-chroot /mnt/vmroot bash -c '
  bootctl install
  echo "default arch.conf" > /boot/loader/loader.conf
  cat > /boot/loader/entries/arch.conf << "EOF"
title   Arch Linux
linux   /vmlinuz-linux
initrd  /initramfs-linux.img
options root=UUID=<ROOT_UUID> rw console=ttyS0,115200n8
EOF
'
```

The `console=ttyS0` option is required. It sends kernel output to the serial console. Without it, you cannot see why the VM fails to boot.

## Write the Hyprland config

Write a config that works without a physical display:

```ini
monitor = , preferred, auto, 1
input {
    kb_layout = us
    follow_mouse = 1
}
animations {
    enabled = no
}
general {
    gaps_in = 2
    gaps_out = 4
}
```

Disable animations. They make screenshots nondeterministic.

## Create the libvirt VM

```sh
sudo virt-install \
  --name hyprland-vm \
  --memory 4096 \
  --vcpus 4 \
  --disk path=/var/lib/libvirt/images/hyprland-vm.qcow2,format=qcow2,bus=virtio \
  --os-variant archlinux \
  --boot uefi \
  --import \
  --network network=default \
  --graphics none \
  --console pty,target_type=serial \
  --noautoconsole
```

Start the default network first. It is not active by default:

```sh
sudo virsh net-start default
sudo virsh net-autostart default
```

## Add the GPU device

A plain headless VM has no GPU. Hyprland needs one to render. Add a virtio GPU with 3D acceleration:

```sh
sudo virsh destroy hyprland-vm
sudo virsh dumpxml hyprland-vm > /tmp/vm.xml
```

Edit `/tmp/vm.xml`. Replace the video element with:

```xml
<video>
  <model type='virtio' heads='1' primary='yes'/>
  <address type='pci' domain='0x0000' bus='0x10' slot='0x01' function='0x0'/>
</video>
```

Then define and start:

```sh
sudo virsh define /tmp/vm.xml
sudo virsh start hyprland-vm
```

Do not use `virtio-vga-gl`. It requires a GL display backend on the host. The headless host has none. The plain `virtio` model works with software rendering in the guest.

## Network

The guest network fails to get a DHCP lease. NetworkManager cannot start a DHCP client. Fix it with a static address:

```sh
nmcli con mod "Wired connection 1" ipv4.method manual \
  ipv4.addresses 192.168.122.10/24 \
  ipv4.gateway 192.168.122.1 \
  ipv4.dns 192.168.122.1
nmcli con up "Wired connection 1"
```

The host firewall may block VM outbound traffic. UFW is the usual cause:

```sh
sudo ufw route allow in on virbr0
sudo ufw allow in on virbr0
sudo ufw reload
```

Without this, the guest cannot reach package mirrors. `pacman` times out with "Resolving timed out".

## Serial console access

The VM has no display. Access the console through the serial port:

```sh
sudo virsh console hyprland-vm
```

Or read the pty directly:

```sh
sudo virsh dumpxml hyprland-vm | grep "source path"
```

The log shows login on `ttyS0`. Log in as `root` or `tester`, password `hyprtest`.

## Run Hyprland headless

The compositor needs a session seat. In a headless VM there is no login session. Use `seatd`:

```sh
sudo systemctl enable --now seatd
```

Start Hyprland without a display:

```sh
#!/bin/bash
export XDG_RUNTIME_DIR=/run/user/1000
export HYPRLAND_HEADLESS_OUTPUT=1
export WLR_NO_HARDWARE_CURSORS=1
exec Hyprland --config /home/tester/.config/hypr/hyprland.conf
```

Run it detached:

```sh
nohup /tmp/start-hypr2.sh > /tmp/hypr2.log 2>&1 < /dev/null &
```

The `HYPRLAND_HEADLESS_OUTPUT` variable makes Hyprland create a virtual output. The log shows a 1280x800 output named `Virtual-1`.

## Known issue: missing command socket

Hyprland creates two sockets:

- `.socket.sock` — command and response
- `.socket2.sock` — event stream

In the headless VM, `.socket.sock` does not always appear. The log shows this error before it fails:

```
drm: Cannot commit when a page-flip is awaiting
```

This is a known issue with virtio DRM and software rendering. The compositor starts, then stops at the page-flip commit. Workarounds to try, in order:

1. Restart Hyprland cleanly (kill all instances, remove the instance dir).
2. Set the monitor to a fixed mode in the config.
3. Use the `WLR_BACKENDS`-style fallback only if the version supports it. Hyprland is not wlroots; that variable is legacy.
4. If the command socket still does not appear, run the smoke tests through `hyprctl` with an explicit `HYPRLAND_INSTANCE_SIGNATURE`.

## SSH access

Copy the test key to the guest:

```sh
ssh-keygen -t ed25519 -f /tmp/vm_test_key -N ""
ssh tester@192.168.122.10 "mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys" < /tmp/vm_test_key.pub
ssh -i /tmp/vm_test_key tester@192.168.122.10 "echo OK"
```

## Deploy the MCP server to the guest

Package the source and copy it:

```sh
tar czf /tmp/hyprland-mcp-src.tgz --exclude node_modules --exclude .git .
scp -i /tmp/vm_test_key /tmp/hyprland-mcp-src.tgz tester@192.168.122.10:/home/tester/
ssh -i /tmp/vm_test_key tester@192.168.122.10 "cd ~ && tar xzf hyprland-mcp-src.tgz && mv src tests scenarios package.json package-lock.json tsconfig.json hyprland-mcp/"
```

The tar includes a `./` prefix. Files land in the home directory, not in `hyprland-mcp/`. Move them into place.

Install Node in the guest:

```sh
sudo pacman -Syy && sudo pacman -S --noconfirm nodejs npm
```

Then run the deterministic test suite in the guest:

```sh
cd ~/hyprland-mcp && npm install && npx tsc --noEmit && npx vitest run
```

## What to check next

The smoke tests need a working Hyprland session in the VM. They test the full loop: launch an app, list windows, focus, screenshot, send input, close. Until the command socket appears, run the deterministic suite and the MCP-level suite. They do not need a live compositor.
