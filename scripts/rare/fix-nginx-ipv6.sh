#!/bin/bash
#
# Fix nginx IPv6 configuration issue
#

set -e

echo "Fixing nginx IPv6 configuration..."

# Disable IPv6 in default site config
sudo sed -i 's/listen \[::\]:80/# listen [::]:80/' /etc/nginx/sites-available/default
sudo sed -i 's/listen \[::\]:443/# listen [::]:443/' /etc/nginx/sites-available/default

echo "Completing nginx installation..."
sudo dpkg --configure -a

echo "Testing nginx configuration..."
sudo nginx -t

echo "Checking nginx status..."
sudo systemctl status nginx --no-pager || true

echo ""
echo "✓ Nginx fix complete!"
echo ""
echo "Now you can re-run the setup script:"
echo "  sudo ./setup-netops-server.py"
