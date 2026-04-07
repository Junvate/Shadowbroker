import pytest

import main


@pytest.mark.parametrize(
    "host",
    [
        "localhost",
        "localhost.localdomain",
        "127.0.0.1",
        "::1",
        "0:0:0:0:0:0:0:1",
        "::",
        "0:0:0:0:0:0:0:0",
        "::ffff:127.0.0.1",
        "10.1.2.3",
        "172.20.1.5",
        "192.168.31.7",
        "fc00::1",
    ],
)
def test_is_local_or_docker_accepts_local_and_private_hosts(host):
    assert main._is_local_or_docker(host) is True


@pytest.mark.parametrize(
    "host",
    [
        "8.8.8.8",
        "1.1.1.1",
        "2606:4700:4700::1111",
        "example.com",
        "",
    ],
)
def test_is_local_or_docker_rejects_public_or_invalid_hosts(host):
    assert main._is_local_or_docker(host) is False
